# UI Comparison Desktop

Cross-browser visual regression tool built on Electron and Playwright. Extracts CSS computed styles from live pages, matches elements across two page versions using a four-phase pipeline, diffs them with tolerance-aware comparison, and produces severity-ranked reports with optional keyframe screenshots.

---

## Table of Contents

- [Workflows](#workflows)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Installation and First Run](#installation-and-first-run)
- [Development Mode](#development-mode)
- [Build Pipeline](#build-pipeline)
- [Packaging](#packaging)
- [Tests and Linting](#tests-and-linting)
- [Directory Structure](#directory-structure)
- [Architecture](#architecture)
- [Electron Contexts](#electron-contexts)
- [Preload API Surface](#preload-api-surface)
- [Webpack Configurations](#webpack-configurations)
- [Design Tokens](#design-tokens)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [How to Add a New IPC Channel](#how-to-add-a-new-ipc-channel)
- [Known Gotchas](#known-gotchas)
- [CI / Release Pipeline](#ci--release-pipeline)
- [Further Reading](#further-reading)

---

## Workflows

| Workflow | Description |
|---|---|
| **Extract** | Capture a single URL into a saved report. |
| **Compare** | Diff two saved reports (baseline vs. compare) in `dynamic` or `static` mode, optionally with side-by-side keyframe screenshots. |
| **Bulk** | Upload an Excel plan (`baseline_url`, `compare_url`, plus optional columns; up to 500 rows) and run comparisons in parallel with bounded concurrency, per-host cooldown, deduplication, resume-on-crash, and an exportable per-row summary. |

The matching pipeline, bulk runner internals, and IDB persistence are documented in [`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md).

---

## Tech Stack

| Category | Tool | Version / Notes |
|---|---|---|
| Runtime | Electron | `^41.1.1` — sandboxed renderer, context isolation, preload bridge |
| Browser automation | Playwright | `^1.48.0` — Chromium, Firefox, WebKit + system Chrome/Edge/Brave |
| Bundler | webpack 5 | Three configs: main, renderer, extractor (`webpack.*.config.js`) |
| Transpiler | Babel 7 | `@babel/preset-env` via `babel-loader` |
| Lint / Format | ESLint 8, Prettier 3 | `.eslintrc.json`, `.prettierrc` |
| Persistence | IndexedDB | Version 9, WAL + circuit breaker (`src/infrastructure/idb-repository.js`) |
| Spreadsheet I/O | xlsx | `^0.18.5` — bulk plan parser + export |
| Concurrency | p-limit | `^4.0.0` — ESM-only, dynamic `import()` in `src/main/bulk-runner.js` |
| Packaging | electron-builder | `^26.8.1` — `electron-builder.yml` |
| Cycle detection | madge | `^8.0.0` (devDependency, ad-hoc use) |

---

## Prerequisites

| Requirement | Details |
|---|---|
| Node.js | 18 LTS or newer |
| npm | Whatever ships with the Node version above |
| OS | Windows 10+, macOS 12+, Linux Ubuntu 20.04+ |
| `PLAYWRIGHT_BROWSERS_PATH` | **Required.** Must point to a directory containing a Playwright `chromium` install. Validated by `scripts/check-env.js` on every `prebuild`. |

---

## Installation and First Run

```bash
git clone <repo-url> ui-comparison-desktop
cd ui-comparison-desktop
npm install                           # runs postinstall -> electron-builder install-app-deps

# Set the env var (persist in your shell profile):
# PowerShell:
$env:PLAYWRIGHT_BROWSERS_PATH = "C:\playwright-browsers"
# bash/zsh:
export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers

npm run install:browsers              # installs chromium, firefox, webkit
npm run build                         # builds extractor + main + renderer
npm start                             # launches dev mode
```

> **Important:** `npm start` does **not** build the extractor bundle. You must run `npm run build` (or at minimum `npm run build:extractor`) at least once before the first extraction. After the bundle exists on disk, watch mode keeps main and renderer fresh; the extractor is only rebuilt when you explicitly run `npm run build:extractor` or `npm run build`.

---

## Development Mode

```bash
npm start
```

Runs three concurrent jobs via `concurrently` (`package.json` `start` script):

1. `webpack --watch` on `webpack.main.config.js` -- produces `dist/index.js` + `dist/preload.js`
2. `webpack --watch` on `webpack.renderer.config.js` -- produces `dist/renderer/app.js` + copies `index.html` + `styles/`
3. `electron .` -- boots the app from `dist/index.js`

> **Warning:** Both webpack configs use `bail: true` under watch. A compile error kills the watch process (exit code 1) while Electron keeps running on the stale bundle. Fix the error and restart `npm start`.

---

## Build Pipeline

The three bundles must be built in this order:

```bash
npm run build:extractor    # 1. dist/extractor-bundle.js  (UMD, window.__uiCompare, target chrome 108)
npm run build:main         # 2. dist/index.js + dist/preload.js  (electron-main, electron 33)
npm run build:renderer     # 3. dist/renderer/app.js + index.html + styles/  (web, chrome 120)
```

`npm run build` runs all three sequentially. Before webpack starts, the `prebuild` hook runs `node scripts/check-env.js`, which validates `PLAYWRIGHT_BROWSERS_PATH` is set, readable, and contains a `chromium` directory.

---

## Packaging

All commands run `npm run build` first, then `electron-builder`.

| Command | Target | Notes |
|---|---|---|
| `npm run dist:win` | Windows NSIS x64 | Sets `CSC_IDENTITY_AUTO_DISCOVERY=false` |
| `npm run dist:mac` | macOS DMG universal (x64 + arm64) | Must run on macOS |
| `npm run dist:linux` | Linux AppImage + .deb x64 | |
| `npm run dist:all` | All platforms | **Do not use for releases** -- cross-OS from a single host produces broken artifacts |

Output goes to `release/`. Configuration lives in `electron-builder.yml`.

---

## Tests and Linting

No Jest/Mocha test runner is configured. Available automated checks:

| Command | What it does |
|---|---|
| `npm run smoke-test` | `electron . --smoke-test` -- asserts extractor bundle on disk + `app.getVersion()` non-empty |
| `npm run lint` | `eslint .` |
| `npm run format` | `prettier --write .` |

`fake-indexeddb` is a devDependency reserved for future unit tests; no source currently imports it.

---

## Directory Structure

| Path | Purpose |
|---|---|
| `src/config/` | Frozen runtime config (`defaults.js`, `browser-capability-profile.js`), boot-time validator |
| `src/core/bulk/` | Plan parser, validator, extraction-key SHA-256 dedup |
| `src/core/comparison/` | Matcher, differ, severity, cascade suppression, keyframe grouper |
| `src/core/extraction/` | In-page extraction pipeline (bundled into `dist/extractor-bundle.js`) |
| `src/core/normalization/` | CSS normalizers (color, size, font, shorthand) + LRU cache |
| `src/core/selectors/` | CSS/XPath generator with timeouts + bounded concurrency |
| `src/core/export/` | HTML/CSV/JSON/Excel exporters, bulk summary, plan template |
| `src/infrastructure/` | IDB repository (WAL + circuit breaker, v9), logger, error tracker, perf monitor |
| `src/main/` | Electron main: lifecycle, IPC handlers, preload, playwright-manager, browser-detector, bulk-runner, protocol-handler, resource-paths |
| `src/renderer/` | State machine, app entry, application workflows, components, styles, utils |
| `src/renderer/application/` | Workflow orchestration (extract, compare, bulk, import/export, report management, notifications) |
| `src/renderer/components/` | UI: shell, browser selector, modal, progress, report list (virtual scroll + multi-select), bulk panel, multi-select toolbar, toast, tooltip |
| `src/renderer/styles/` | `tokens.css` design tokens + component stylesheets |
| `scripts/` | `check-env.js` (env validation), `strip-comments.js` (dev utility) |
| `docs/` | Design notes (not loaded at runtime) |
| `dist/` | Webpack output (not committed) |
| `release/` | electron-builder output (not committed) |
| `.playwright-browsers/` | Project-local browser tree shipped via `extraResources` |
| `.github/workflows/` | CI release pipeline |

---

## Architecture

Four layers with a strict one-way dependency rule:

```
presentation  (src/renderer/components/, src/renderer/styles/)
      |
application   (src/renderer/application/, src/renderer/state.js, src/renderer/app.js)
      |
core          (src/core/**)          infrastructure  (src/infrastructure/**)
```

- A module may import only from layers strictly below it, plus peers within the same layer.
- `core/` and `infrastructure/` are peers. Neither imports the other except through narrow surfaces (currently: `core/*` imports `infrastructure/logger.js`).
- Nothing in `core/` may import Electron, the renderer DOM, or anything under `src/renderer/` or `src/main/`.
- Components must not call `ipcRenderer` directly -- they use `window.electronAPI`.
- `src/main/` is its own runtime (Node + Electron-main). It imports from `src/core/` but never from `src/renderer/` or `src/infrastructure/`.

Enforcement: editorial discipline + webpack aliases (`@core`, `@config`, `@infra`) + target differentiation across three webpack configs. `madge` is available for ad-hoc cycle detection.

See [`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md) for the full architecture diagram with file-level edges and failure modes.

---

## Electron Contexts

| Context | Runtime | Key files |
|---|---|---|
| **Main** (Node.js) | Full Node + Electron-main APIs | `src/main/index.js`, `src/main/ipc-handlers.js`, `src/main/playwright-manager.js`, `src/main/bulk-runner.js`, `src/main/protocol-handler.js`, `src/main/resource-paths.js`, `src/main/browser-detector.js` |
| **Preload** (isolated bridge) | `contextBridge.exposeInMainWorld` | `src/main/preload.js`, `src/main/ipc-channels.js` |
| **Renderer** (sandboxed Chromium) | No Node access; uses `window.electronAPI` | `src/renderer/**`, `src/infrastructure/**` (IndexedDB lives here) |
| **In-page** (target site) | Injected UMD bundle in target's browsing context | `src/core/extraction/**` compiled to `dist/extractor-bundle.js` (exposes `window.__uiCompare`) |

> **Note:** IndexedDB lives only in the renderer process. The main process cannot access it. Comparisons run in main but persistence happens after results return to the renderer via IPC.

---

## Preload API Surface

The complete `window.electronAPI` object exposed by `src/main/preload.js`:

| Method / Property | IPC Channel | Pattern |
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
| `onComparisonProgress(cb)` | `COMPARISON_PROGRESS` | push (returns unsubscribe fn) |
| `onExtractionProgress(cb)` | `EXTRACTION_PROGRESS` | push (returns unsubscribe fn) |
| `onOperationCancelled(cb)` | `OPERATION_CANCELLED` | push (dead -- no producer) |
| `onContextAction(cb)` | `CONTEXT_ACTION` | push (returns unsubscribe fn) |
| `onMenuAction(cb)` | `MENU_ACTION` | push (returns unsubscribe fn) |
| `onAppNotification(cb)` | `APP_NOTIFICATION` | push (dead -- no producer) |
| `onBulkProgress(cb)` | `BULK_PROGRESS` | push (returns unsubscribe fn) |
| `onBulkPairCompleted(cb)` | `BULK_PAIR_COMPLETED` | push (returns unsubscribe fn) |
| `onBulkJobComplete(cb)` | `BULK_JOB_COMPLETE` | push (returns unsubscribe fn) |
| `platform` | -- | property (`process.platform`) |

---

## Webpack Configurations

| Config file | Entry | Target | Output | Key details |
|---|---|---|---|---|
| `webpack.main.config.js` | `src/main/index.js`, `src/main/preload.js` | electron-main, Electron 33 | `dist/index.js`, `dist/preload.js` | Externals: `playwright`, `electron-log`, `electron-updater`. Aliases: `@core`, `@config`, `@infra`. `bail: true`. |
| `webpack.renderer.config.js` | `src/renderer/app.js` | web, Chrome 120 | `dist/renderer/app.js` | `CopyStaticAssetsPlugin` copies `index.html` + `styles/` to `dist/renderer/`. Aliases `electron` to stub, `electron-log` to `electron-log/renderer`. |
| `webpack.extractor.config.js` | `src/core/extraction/extractor.js` | web, Chrome 108 | `dist/extractor-bundle.js` (UMD `__uiCompare`) | Aliases `electron`/`electron-log` to `src/core/extraction/_page_stubs_/`. No code splitting. |

---

## Design Tokens

Defined in `src/renderer/styles/tokens.css`. All other stylesheets consume these tokens -- never raw values.

| Prefix | Covers |
|---|---|
| `--color-*` | Brand, surface, text, border, severity, match, success, warning, destructive, scrim |
| `--font-*` | Family, size, weight, line-height |
| `--space-*` | Spacing scale |
| `--radius-*` | Border radii |
| `--shadow-*` | Elevation levels |
| `--z-*` | Z-index layers |
| `--motion-*` | Transition durations and easing |

Dark theme only (no light variant). Typography: Inter (400/500/600) for UI, JetBrains Mono (400) for monospace.

---

## Keyboard Shortcuts

| Action | Windows / Linux | macOS |
|---|---|---|
| DevTools | `Ctrl+Shift+I` | `Cmd+Option+I` |
| Diagnostics overlay | `Ctrl+Shift+D` | `Cmd+Shift+D` |
| Toggle sidebar | `Ctrl+\` or `Ctrl+B` | `Cmd+\` or `Cmd+B` |
| Focus search | `/` | `/` |
| Go to Extract | `e` | `e` |
| Go to Compare | `c` | `c` |
| Clear search | `Escape` (when search has value) | `Escape` |

---

## How to Add a New IPC Channel

This is the contract that must hold for any new IPC channel:

1. **Add the constant** in `src/main/ipc-channels.js`. Convention: `UPPER_SNAKE_CASE` for both key and string value.

2. **Register the handler** inside one of the `_register*Handlers(...)` functions in `src/main/ipc-handlers.js` (or create a new group and call it from `registerIpcHandlers`). Invoke handlers must return `{ success, ... }` -- never throw uncaught across the IPC boundary.

3. **Expose in preload** (`src/main/preload.js`):
   - Request/response: `ipcRenderer.invoke(CH.YOUR_CHANNEL, payload)`
   - Main-to-renderer push: use the `makePushBridge(CH.YOUR_CHANNEL)` helper (returns an unsubscribe function). Push from main using `_pushToWindow` in `ipc-handlers.js`.

4. **Consume from the renderer** via `window.electronAPI.<method>` -- never import `electron` directly from a renderer module.

5. **Sandbox safety:** The handler runs in main with full Node access. It must never call IndexedDB (renderer-only) and must not import from `src/renderer/`.

See [`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md) for the complete IPC registry with every channel name, direction, payload type, and handler location.

---

## Known Gotchas

### Build

- **Extractor bundle must exist before first extraction.** `npm start` only watches main + renderer. Run `npm run build:extractor` (or `npm run build`) at least once. The Playwright manager probes three candidate paths defined in `src/main/playwright-manager.js` (`getExtractorBundleSource`).
- **`PLAYWRIGHT_BROWSERS_PATH` must exist and contain `chromium`** before any `npm run build` (`prebuild` hard-fails via `scripts/check-env.js`) and before any `npm run dist` (`prepackage` hard-fails).
- **`bail: true` under watch.** A compile error kills the watch process while Electron keeps running on a stale bundle. Watch `concurrently` output.
- **`dist:all` produces broken non-host artifacts.** Cross-OS builds from a single host do not work. Use per-OS CI runners.

### Runtime

- **`electronAPI` undefined is fatal.** If `window.electronAPI` is missing (typically a moved `dist/preload.js`), `src/renderer/app.js` replaces the body with a fatal banner. Confirm `BrowserWindow.webPreferences.preload` resolves to `dist/preload.js`.
- **IDB lives only in the renderer.** Main process cannot access IndexedDB. Comparisons run in main but persistence happens after results return to the renderer via IPC.
- **Renderer is sandboxed.** `app.enableSandbox()` is called in `src/main/index.js`. All Node capabilities the renderer needs must come through the preload bridge.
- **IDB version is `9`.** A fresh install creates every store at v9 atomically. Upgrading from v8 adds `bulk_jobs`, `bulk_pairs`, and new indexes. See [`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md) for the full schema.
- **Storage-degraded events cancel running bulk jobs.** Three consecutive IDB write failures open the circuit until renderer reload. `storage-degraded` events are dispatched on `window` with `detail.reason` of `CIRCUIT_OPEN` or `WAL_REPLAY_EXHAUSTED`.
- **WAL replay bounded to 3 attempts.** `SAVE_VISUAL_BLOB` entries are never replayed (binary payload may be lost). `SAVE_BULK_JOB` / `SAVE_BULK_PAIR` entries are force-failed at boot if pending.
- **Bulk eviction skips bulk-tagged rows.** `_evictAndWrite` excludes bulk rows from the `MAX_COMPARISONS=20` / `storage.maxReports=50` eviction counts. Bulk retention is bounded separately by `BULK_MAX_RETAINED_JOBS=10` in `src/infrastructure/idb-repository.js`.
- **Bulk concurrency clamped by host RAM.** Machines with < 12 GiB total RAM get halved concurrency. Heterogeneous plans (mixed `browserType`) on those machines are forced to concurrency 1. See `_clampConcurrency` in `src/renderer/application/bulk-workflow.js`.
- **HPID dual scheme.** Elements carry both relative and absolute HPIDs. The matcher uses relative; cascade suppression uses absolute. Mixing them silently corrupts suppression for filtered extractions. See [`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md) for details.
- **Browser detection result is module-cached.** `src/main/browser-detector.js` memoizes the first detection. Pass `{ refresh: true }` to `getAvailableBrowsers` to force re-detection.
- **System Firefox / Safari are visible but not launchable.** Playwright requires its own patched builds. The browser selector greys them out with a tooltip.
- **WebKit visual capture fails over to Chromium silently.** If WebKit's screenshot path raises a `Page.snapshotRect`-shaped error, the screenshot phase retries with Chromium. A `screenshot-engine-fallback` warning is appended to `result.visualDiffs.devToolsWarnings`.
- **Multi-select delete is optimistic with a 5s undo window.** IDB deletes are committed only after the timeout in `src/renderer/application/report-manager.js`. A crash during the window means no deletes are committed.
- **Multi-select mode persists only in memory.** Not saved to `localStorage` or IDB. A page reload exits selection mode.

### Dead Code

- **`better-sqlite3`** -- declared in `package.json` but no `src/` file imports it. All persistence is IndexedDB. Rebuilt against Electron via `postinstall` but never loaded.
- **`electron-updater`** -- declared as a dependency and listed as a webpack external in `webpack.main.config.js`, but no `src/` file imports it and `electron-builder.yml` has no `publish` configuration.
- **`OPERATION_CANCELLED` and `APP_NOTIFICATION` IPC channels** -- constants exist in `src/main/ipc-channels.js`, bridged in `src/main/preload.js`, and subscribed to in `src/renderer/app.js`. No code path in `src/main/` ever calls `webContents.send` on either channel.
- **`recoverFrozenSessions()`** -- runs at boot in `src/main/playwright-manager.js` but iterates an in-process `_browsers` Map that is always empty at boot. Defensive but currently a no-op.

### Operational

- **Help menu links are placeholders.** They point to `your-org/ui-comparison` GitHub URLs. Replace before shipping.
- **macOS traffic-light padding.** `html.platform-darwin #app-root` adds a left inset via `electronAPI.platform`. Removing the platform class causes window-control overlap. See `src/renderer/styles/shell.css`.
- **Context menu has three branches.** The native context menu in `src/main/index.js` branches on payload shape: (1) `bulkJobId` present, (2) `multiSelect === true`, (3) `reportId` present. Extend the correct branch when adding actions.
- **`PICK_DIRECTORY` / `EXPORT_FILE_TO_DIRECTORY` defense-in-depth.** `EXPORT_FILE_TO_DIRECTORY` only writes into directories the user has approved this session via `PICK_DIRECTORY`. Paths outside that set are rejected.
- **`PLAYWRIGHT_BROWSERS_PATH` only covers bundled engines.** System browsers are detected and launched independently via `channel:` or `executablePath:` in `src/main/browser-detector.js`.

### Known Bug

- **`BulkJobState.status` JSDoc at `src/renderer/state.js:7` is incomplete.** Declares `'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'` but the reducer also produces `'parsed'` and `'partial'`. See [`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md) for the full status union.

---

## CI / Release Pipeline

Defined in `.github/workflows/release-build.yml`. Triggered on `workflow_dispatch`.

| Job | Runner | Node | Browsers installed | Packages |
|---|---|---|---|---|
| `build-win` | `windows-latest` | 22 | Chromium only | `release/*.exe`, `*.blockmap`, `latest.yml` |
| `build-mac` | `macos-latest` | 22 | Chromium only | `release/*.dmg` |

Both jobs use `actions/checkout@v5`, `actions/setup-node@v5`, `actions/upload-artifact@v4`. Code signing is disabled (`CSC_IDENTITY_AUTO_DISCOVERY=false`). No Linux job is defined yet.

---

## Further Reading

[`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md) covers:

- Full IPC registry (every channel name, direction, payload type, handler location)
- IndexedDB schema (all stores, indexes, upgrade path from v5 through v9)
- State machine (complete action/reducer reference, transition rules)
- Matching pipeline internals (4-phase algorithm, scoring, thresholds)
- Bulk runner internals (concurrency model, dedup, cooldown, resume, eviction)
- Normalization engine (per-property strategies, engine quirk profiles)
- Failure modes and recovery paths
