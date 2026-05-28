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
- [Design Tokens & Theme](#design-tokens--theme)
- [Tolerance Profile](#tolerance-profile)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [How to Add a New IPC Channel](#how-to-add-a-new-ipc-channel)
- [Known Gotchas](#known-gotchas)
- [SauceLabs — Live Account Verification](#saucelabs--live-account-verification)
- [CI / Release Pipeline](#ci--release-pipeline)
- [Further Reading](#further-reading)

---

## Workflows

| Workflow | Description |
|---|---|
| **Extract** | Capture a single URL into a saved report. Pick the browser (Playwright Chromium / Firefox / WebKit, plus detected system Chrome / Edge / Brave) from the in-panel selector. Optional `class` / `id` / `tag` filters narrow the DOM. |
| **Compare** | Diff two saved reports (baseline vs. compare) in `dynamic` or `static` mode. **User-tunable tolerances** (color ΔRGB, size px, opacity Δ) sit on the panel and persist across sessions. Optional side-by-side keyframe screenshots. |
| **Bulk** | Upload an Excel plan (`baseline_url`, `compare_url`, plus optional columns; up to 500 rows) and run comparisons in parallel with bounded concurrency, per-host cooldown, deduplication, resume-on-crash, and an exportable per-row summary. |
| **SauceLabs** | Run extractions or full comparisons on SauceLabs cloud VMs via `saucectl`. Supports credential validation, multi-region, parallel baseline+compare sessions, adaptive polling, partial-failure retry, cancellation, and resume-after-restart. The panel exposes Playwright-version selection, build/tag/visibility metadata, mobile devices with orientation, and a compatibility matrix that filters incompatible combinations. |

Both light and dark themes are first-class — toggle from the status-bar
button. Exported HTML reports inherit the user's theme.

The matching pipeline, bulk runner internals, IDB persistence, tolerance
profile system, and theme system are documented in
[`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md).

---

## Tech Stack

| Category | Tool | Version / Notes |
|---|---|---|
| Runtime | Electron | `^41.1.1` — sandboxed renderer, context isolation, preload bridge |
| Browser automation | Playwright | `^1.48.0` — Chromium, Firefox, WebKit + system Chrome/Edge/Brave |
| Cloud execution | saucectl | `>=0.200.0 <1.0.0` — SauceLabs CLI for cloud-based extraction via Playwright test runner. Default Playwright runtime in the panel: `1.57.0`. Supported list: `1.58.2 / 1.58.1 / 1.57.0 / 1.56.1 / 1.55.1 / 1.54.1 / 1.52.0 / 1.50.1 / 1.49.1`. |
| Bundler | webpack 5 | Three configs: main, renderer, extractor (`webpack.*.config.js`) |
| Transpiler | Babel 7 | `@babel/preset-env` via `babel-loader` |
| Lint / Format | ESLint 8, Prettier 3 | `.eslintrc.json`, `.prettierrc` |
| Test runner | Vitest | `^4.1.6` — unit tests in `test/unit/` |
| Persistence | IndexedDB | Version 11, WAL + circuit breaker (`src/infrastructure/idb-repository.js`) |
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
| `saucectl` (optional) | **Required only for the SauceLabs tab.** In dev mode: `npm install -g saucectl` (must be on `PATH`). In packaged builds: bundled automatically from `.saucectl-bin/${os}/${arch}/` via `extraResources`. The app also auto-downloads a compatible version to `userData/saucectl/bin/` on first use. Compatible range: `>=0.200.0 <1.0.0`. |

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

Runs four concurrent jobs via `concurrently` (`package.json` `start` script):

1. `webpack --watch` on `webpack.main.config.js` -- produces `dist/index.js` + `dist/preload.js`
2. `webpack --watch` on `webpack.renderer.config.js` -- produces `dist/renderer/app.js` + copies `index.html` + `styles/`
3. `webpack --watch` on `webpack.saucelabs-runner.config.js` -- produces `dist/saucelabs-runner/*.js`
4. `electron .` -- boots the app from `dist/index.js`

> **Warning:** Both webpack configs use `bail: true` under watch. A compile error kills the watch process (exit code 1) while Electron keeps running on the stale bundle. Fix the error and restart `npm start`.

---

## Build Pipeline

The four bundles must be built in this order:

```bash
npm run build:extractor          # 1. dist/extractor-bundle.js          (UMD, window.__uiCompare, target chrome 108)
npm run build:main               # 2. dist/index.js + dist/preload.js   (electron-main, electron 33)
npm run build:renderer           # 3. dist/renderer/app.js + index.html + styles/  (web, chrome 120)
npm run build:saucelabs-runner   # 4. dist/saucelabs-runner/{extract.spec.js,keyframe-grouper.js,schemas.js}
```

`npm run build` runs all four sequentially. Before webpack starts, the `prebuild` hook runs `node scripts/check-env.js`, which validates `PLAYWRIGHT_BROWSERS_PATH` is set, readable, and contains a `chromium` directory.

The fourth bundle (`saucelabs-runner`) is the test script that runs on
the SauceLabs cloud VM. It is staged at submission time into a fresh tmp
project alongside `dist/extractor-bundle.js` (see
[`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md) §16.5).

---

## Packaging

All commands run `npm run build` first, then `electron-builder`.

| Command | Target | Notes |
|---|---|---|
| `npm run dist:win` | Windows NSIS x64 | Sets `CSC_IDENTITY_AUTO_DISCOVERY=false` |
| `npm run dist:mac` | macOS DMG universal (x64 + arm64) | Must run on macOS |
| `npm run dist:linux` | Linux AppImage + .deb x64 | |
| `npm run dist:all` | All platforms | **Do not use for releases** -- cross-OS from a single host produces broken artifacts |

Output goes to `release/`. Configuration lives in `electron-builder.yml`. The packaged app bundles both the Playwright browser tree (from `.playwright-browsers/`) and platform-specific `saucectl` binaries (from `.saucectl-bin/${os}/${arch}/`) as `extraResources`.

---

## Tests and Linting

| Command | What it does |
|---|---|
| `npm test` | `vitest run` — executes unit tests in `test/unit/` |
| `npm run test:watch` | `vitest` in watch mode |
| `npm run smoke-test` | `electron . --smoke-test` — asserts extractor bundle on disk + `app.getVersion()` non-empty |
| `npm run lint` | Runs `eslint .` followed by `node scripts/lint-no-darwin-color.js` (custom rule that forbids `Cocoa`/`darwin`-specific hard-coded colour literals) |
| `npm run lint:no-darwin-color` | Just the custom darwin-colour check |
| `npm run format` | `prettier --write .` |

Unit tests use Vitest with `fake-indexeddb` (devDependency) for IDB schema tests. Configuration in `vitest.config.js`.

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
| `src/infrastructure/` | IDB repository (WAL + circuit breaker, v11), logger, error tracker, perf monitor |
| `src/main/` | Electron main: lifecycle, IPC handlers, preload, playwright-manager, browser-detector, bulk-runner, saucelabs-manager, saucelabs-binary-manager, protocol-handler, resource-paths |
| `src/saucelabs-runner/` | Playwright spec + helpers staged onto the SauceLabs VM (`extract.spec.js`, `keyframe-grouper.js`, `schemas.js`). Bundled separately by `webpack.saucelabs-runner.config.js`. |
| `src/renderer/` | State machine, app entry, application workflows, components, styles, utils |
| `src/renderer/application/` | Workflow orchestration (extract, compare, bulk, saucelabs, import/export, report management, notifications) |
| `src/renderer/components/` | UI: shell, browser selector, modal, progress, report list (virtual scroll + multi-select), bulk panel, saucelabs panel, multi-select toolbar, toast, tooltip |
| `src/renderer/styles/` | `tokens.css` design tokens + component stylesheets |
| `.saucectl-bin/` | Platform-specific `saucectl` binaries bundled via `extraResources` for packaged builds |
| `test/` | Vitest unit tests (`test/unit/*.test.js`) |
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
| `sauceValidateCredentials(params)` | `SAUCE_VALIDATE_CREDENTIALS` | invoke |
| `sauceSubmitJob(params)` | `SAUCE_SUBMIT_JOB` | invoke |
| `sauceSubmitComparison(params)` | `SAUCE_SUBMIT_COMPARISON` | invoke |
| `sauceCancelJob(params)` | `SAUCE_CANCEL_JOB` | invoke |
| `sauceRetryFailedSession(params)` | `SAUCE_RETRY_FAILED_SESSION` | invoke |
| `sauceReadKeyframe(params)` | `SAUCE_READ_KEYFRAME` | invoke |
| `onSauceJobProgress(cb)` | `SAUCE_JOB_PROGRESS` | push (returns unsubscribe fn) |
| `onSauceJobComplete(cb)` | `SAUCE_JOB_COMPLETE` | push (returns unsubscribe fn) |
| `platform` | -- | property (`process.platform`) |

---

## Webpack Configurations

| Config file | Entry | Target | Output | Key details |
|---|---|---|---|---|
| `webpack.main.config.js` | `src/main/index.js`, `src/main/preload.js` | electron-main, Electron 33 | `dist/index.js`, `dist/preload.js` | Externals: `playwright`, `electron-log`, `electron-updater`. Aliases: `@core`, `@config`, `@infra`. `bail: true`. |
| `webpack.renderer.config.js` | `src/renderer/app.js` | web, Chrome 120 | `dist/renderer/app.js` | `CopyStaticAssetsPlugin` copies `index.html` + `styles/` to `dist/renderer/`. Aliases `electron` to stub, `electron-log` to `electron-log/renderer`. |
| `webpack.extractor.config.js` | `src/core/extraction/extractor.js` | web, Chrome 108 | `dist/extractor-bundle.js` (UMD `__uiCompare`) | Aliases `electron`/`electron-log` to `src/core/extraction/_page_stubs_/`. No code splitting. |
| `webpack.saucelabs-runner.config.js` | `src/saucelabs-runner/extract.spec.js` (+ `keyframe-grouper.js`, `schemas.js`) | node | `dist/saucelabs-runner/*.js` | Bundles the test that runs on the SauceLabs VM. Staged into a fresh tmp project on every job by `_stageRunnerProject`. |

---

## Design Tokens & Theme

Defined in `src/renderer/styles/tokens.css`. All other stylesheets consume these tokens — never raw values.

| Prefix | Covers |
|---|---|
| `--color-*` | Brand, surface, text, border, severity, match, success, warning, destructive, scrim, banner |
| `--font-*` | Family, size, weight, line-height |
| `--space-*` | Spacing scale |
| `--radius-*` | Border radii |
| `--shadow-*` | Elevation levels |
| `--z-*` | Z-index layers |
| `--motion-*` | Transition durations and easing |

**Both dark and light themes** are supported — `tokens.css` defines a
full palette under `[data-theme="dark"]` and `[data-theme="light"]`. The
preference is bootstrapped synchronously in `index.html` from
`localStorage.ui-theme` (falling back to `prefers-color-scheme`) so there
is no flash of unthemed content. The status-bar button (`#theme-toggle`)
flips the active theme.

The HTML report exporter (`src/core/export/comparison-exporters/html-exporter.js`)
inherits the editor's theme via the same `localStorage` key and emits
both palettes inline; the report itself ships its own theme toggle that
persists to a separate `localStorage.ui-theme-report` key so reports can
be viewed independently of the editor's preference.

Typography: Inter (400/500/600) for UI, JetBrains Mono (400) for monospace.

---

## Tolerance Profile

The Compare panel exposes three numeric inputs under **Tolerance**:

| Field | Range | Default | Meaning |
|---|---|---|---|
| Color (ΔRGB) | 0–255 | 8 | Per-channel RGB delta below which a colour change is ignored |
| Size (px) | 0–100 | 5 | Absolute pixel delta below which a size/spacing change is ignored |
| Opacity (Δ) | 0–1 | 0.05 | Absolute opacity-float delta below which an opacity change is ignored |

Defaults live in `src/config/defaults.js` under `comparison.defaultTolerances`
and are validated at boot (`src/config/validator.js`). Edits in the panel
are persisted in IDB (`app_settings` store, key `tolerance_profile`)
with a 300 ms debounce on `input` and an immediate flush on `change`/blur.
On the next launch the persisted profile reseeds the inputs.

The tolerances are applied in **both** `static` and `dynamic` modes —
they are no longer a per-mode value. Saved comparisons embed the
`tolerancesSnapshot` they ran under, so re-opening a historical report
shows the same severity verdicts; the result-panel summary bar renders
a `Tol C/S/O` badge for any comparison that has the snapshot. Legacy
comparisons saved before this feature land show "Tolerances: —" with a
tooltip explaining the absence.

Bulk and SauceLabs comparisons currently use the boot defaults (not the
user override). See [`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md) §17 for the
full lifecycle and IPC contract.

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
| Collapse expanded sidebar | `Escape` (when focus is inside left panel) | `Escape` |
| Dismiss error / pre-flight banner | `Enter` (when phase is error) | `Enter` |

The Bulk and SauceLabs sections are reached via the nav buttons
(`Bulk` / `SauceLabs` in the main pane section nav). Theme toggle is
in the status bar.

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
- **IDB version is `11`.** A fresh install creates every store at v11 atomically. Upgrading from v9 adds `sauce_jobs` (v10) and `app_settings` (v11). The `app_settings` store currently holds a single user-tolerance-profile row keyed `tolerance_profile`. See [`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md) for the full schema.
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

### SauceLabs

- **`saucectl` must be available.** The binary is resolved in priority order: (1) downloaded to `userData/saucectl/bin/`, (2) bundled at `resources/saucectl/`, (3) on `PATH`. If none is found, `SAUCE_VALIDATE_CREDENTIALS` returns an error before the API call. The binary manager auto-updates against GitHub releases within the `>=0.200.0 <1.0.0` semver range, with SHA-256 checksum verification.
- **Credentials are memory-only.** Never persisted to disk. Cleared on app restart. In-flight SauceLabs jobs are persisted to IDB (`sauce_jobs` store) and can be resumed after providing credentials again.
- **Compatibility matrix is enforced UI-side.** The panel's Playwright Version dropdown filters the Browser and Platform dropdowns through `SAUCE_COMPATIBILITY_MATRIX` (in `src/core/saucelabs-bridge/constants.js`). Selecting Playwright 1.57.0 + macOS 12 + WebKit, for example, is impossible from the UI because the matrix excludes it. A defensive `isValidCombination` check inside `_generateYaml` logs a warning if an invalid combo somehow reaches it.
- **`chrome` (VM-installed) is a separate engine** alongside `chromium`. Use `chrome` to test against the VM's pre-installed Chrome rather than Playwright's bundled Chromium.
- **Mobile devices have explicit viewports.** `MOBILE_DEVICES` (in `src/core/saucelabs-bridge/constants.js`) declares a `viewport` and `deviceScaleFactor` per device. The panel exposes Portrait / Landscape — landscape mode flips viewport `{w,h}` before staging the runner project.
- **YAML metadata is sanitised.** Build name, tags, tunnel name, and tunnel owner all flow through `_sanitiseYamlScalar` (max-length, no newlines, escape `\` and `"`). Overlong / multi-line input throws before saucectl is spawned.
- **Concurrency `>1` requires a matching SauceLabs entitlement.** The panel exposes 1–5 in the metadata expander; selecting `2` runs baseline + compare in parallel on the cloud (independent of the panel's parallelism, which always starts both sessions concurrently). The hint above the field warns about this.
- **Adaptive polling backoff.** Session polling intervals escalate: 10 s for the first 2 min, 20 s for 2–5 min, 30 s for 5–10 min, then 60 s until the 90-min timeout. Up to 8 consecutive errors before giving up. Errors apply exponential backoff (up to 5 min).
- **Partial failure and retry.** If one side of a comparison (baseline or compare) fails while the other succeeds, the job enters `partially_failed` state. The user can retry just the failed side without re-running the successful session. Retry reuses the original Playwright version, build name, tags, visibility, timeout, and tunnel owner from the persisted `sauce_jobs` row.
- **Cancellation kills saucectl + DELETEs remote sessions.** `SAUCE_CANCEL_JOB` sends SIGTERM→SIGKILL to any in-flight saucectl child processes and DELETEs remote sessions via the SauceLabs REST API. An in-process `AbortController` per job aborts all polling loops.
- **saucectl timeout is 10 minutes.** If `saucectl run` does not exit within `saucelabs.saucectlTimeoutMs` (default 10 min), the child is SIGKILL'd.
- **Cross-session abort.** In comparison mode, if one session fails polling, the sibling session's polling is also aborted to avoid a 90-min wait.

### Dead Code

- **`better-sqlite3`** — declared in `package.json` but no `src/` file imports it. All persistence is IndexedDB. Rebuilt against Electron via `postinstall` but never loaded.
- **`electron-updater`** — declared as a dependency and listed as a webpack external in `webpack.main.config.js`, but no `src/` file imports it and `electron-builder.yml` has no `publish` configuration.
- **`OPERATION_CANCELLED` and `APP_NOTIFICATION` IPC channels** — constants exist in `src/main/ipc-channels.js`, bridged in `src/main/preload.js`, and subscribed to in `src/renderer/app.js`. No code path in `src/main/` ever calls `webContents.send` on either channel.
- **`recoverFrozenSessions()`** — runs at boot in `src/main/playwright-manager.js` but iterates an in-process `_browsers` Map that is always empty at boot. Defensive but currently a no-op.

### Operational

- **Help menu links are placeholders.** They point to `your-org/ui-comparison` GitHub URLs. Replace before shipping.
- **macOS traffic-light padding.** `html.platform-darwin #app-root` adds a left inset via `electronAPI.platform`. Removing the platform class causes window-control overlap. See `src/renderer/styles/shell.css`.
- **Context menu has three branches.** The native context menu in `src/main/index.js` branches on payload shape: (1) `bulkJobId` present, (2) `multiSelect === true`, (3) `reportId` present. Extend the correct branch when adding actions.
- **`PICK_DIRECTORY` / `EXPORT_FILE_TO_DIRECTORY` defense-in-depth.** `EXPORT_FILE_TO_DIRECTORY` only writes into directories the user has approved this session via `PICK_DIRECTORY`. Paths outside that set are rejected.
- **`PLAYWRIGHT_BROWSERS_PATH` only covers bundled engines.** System browsers are detected and launched independently via `channel:` or `executablePath:` in `src/main/browser-detector.js`.

---

## SauceLabs — Live Account Verification

The following aspects of the SauceLabs integration cannot be verified by unit tests or mocked HTTP responses and require a real SauceLabs account with Playwright session-creation entitlements:

1. **Artifact write path.** The generated test script writes `extraction-result.json`, `screenshots-manifest.json`, and `keyframe-N.webp` files from inside the SauceLabs VM. Verify that these files appear in the session's artifact list via `GET /rest/v1/{username}/jobs/{sessionId}/assets` and are downloadable with correct, non-zero content.

2. **Actual session polling.** Confirm that `GET /rest/v1/{username}/jobs/{sessionId}` transitions through `in progress` → `complete`/`passed` within the expected time window (typically 1–3 minutes for a simple page). Verify that the adaptive backoff schedule (10 s / 20 s / 30 s / 60 s) does not cause premature timeout on real SauceLabs infrastructure latency.

3. **Full comparison round-trip.** Submit a comparison (two URLs) via the SauceLabs tab, wait for both sessions to complete, download artifacts, run local comparison, and confirm the comparison result appears in the report list with visual keyframe screenshots rendered correctly. This exercises the entire pipeline end-to-end: YAML generation → saucectl spawn → session polling → artifact download → Comparator → post-comparison keyframe filter → IDB persistence → protocol-handler blob registration → UI rendering.

These checks should be run manually at each phase sign-off. They are not part of CI (they require credentials and consume SauceLabs concurrency).

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
- IndexedDB schema (all stores, indexes, upgrade path from v5 through v11 — including `sauce_jobs` v10 and `app_settings` v11)
- State machine (complete action/reducer reference, transition rules)
- Matching pipeline internals (4-phase algorithm, scoring, thresholds)
- CSS diff engine (severity buckets, cascade suppression, normalization pipeline, the size-property classifier)
- Bulk runner internals (concurrency model, dedup, cooldown, resume, eviction)
- Normalization engine (per-property strategies, engine quirk profiles)
- SauceLabs pipeline (binary resolution hierarchy, dual-session state machine, polling, credential flow, post-comparison keyframe filter, close-and-resume, `_parseSauceSessionId` contract, the compatibility matrix, mobile devices with viewports/DPR/orientation, YAML sanitisation)
- Tolerance profile system (boot defaults, IDB persistence, IPC contract, snapshot stamping, validator rules)
- Theme system (light/dark CSS variable cascade, HTML-export theme inheritance, banner colour tokens)
- Failure modes and recovery paths
