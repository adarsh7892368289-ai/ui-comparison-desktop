# UI Comparison Desktop

> Onboarding guide for engineers joining this project. For exhaustive subsystem
> reference (IPC registry, IDB schema, matching pipeline internals, failure modes,
> etc.) see [`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md).

## What this application does

UI Comparison Desktop is an Electron application that uses Playwright to load two
URLs, inject a webpack-bundled in-page extractor that walks the live DOM and reads
`getComputedStyle` for ~70 CSS properties on every visible element, then runs a
four-phase element-matching pipeline (test-attribute anchoring → sequence alignment
→ HPID-suffix realignment → legacy strategy pool) and a tolerance-aware
PropertyDiffer over normalized styles to produce a per-element, per-property
severity-ranked diff report. Results (including optional CDP-driven keyframe
screenshots) are persisted in IndexedDB inside the renderer process behind a
Write-Ahead Log and a 3-strike circuit breaker, and rendered through a
token-based, virtual-scrolled UI.

## Prerequisites

| Requirement | Exact version |
|---|---|
| Node.js | 18 LTS or newer (the repo uses native ES modules; ESLint targets `ecmaVersion: latest`) |
| npm | Whatever ships with the Node version above |
| Electron | `^41.1.1` (pinned in `package.json` — do not upgrade casually; preload + sandbox model is tied to this major) |
| Playwright | `^1.48.0` |
| electron-builder | `^26.8.1` |
| webpack | `^5.96.0` |
| Babel | `^7.24.0` |
| OS | Windows 10+, macOS 12+, or Linux (Ubuntu 20.04+) |
| `PLAYWRIGHT_BROWSERS_PATH` | **Required** environment variable. Must point to a directory that contains a Playwright `chromium` install. Validated by `scripts/check-env.js` on every `prebuild`. |

Native dependencies (`better-sqlite3`) are rebuilt against Electron via
`electron-builder install-app-deps` in the `postinstall` hook.

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
   tree to `dist/renderer/`.
3. `electron .` — boots the app against the package `main` field
   (`dist/index.js`).

**Sequencing constraint:** Both webpack configs use `bail: true` while running
under `--watch`. If either watch process hits a compile error it exits with
code 1. `concurrently` will keep Electron running, but the bundle will be stale
or missing. Fix the error and rerun `npm start` (or run `electron .` after a
clean `npm run build`).

DevTools shortcut: `Ctrl+Shift+I` (Windows/Linux), `Cmd+Option+I` (macOS).

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
| `src/config/` | Deep-frozen runtime configuration and its boot-time validator. |
| `src/core/comparison/` | Pure-Node matching, diffing, severity, cascade suppression, keyframe grouping. |
| `src/core/extraction/` | The in-page extraction pipeline (bundled into `extractor-bundle.js`). |
| `src/core/normalization/` | CSS color/unit/font normalizers and a dual LRU cache, used before diffing. |
| `src/core/selectors/` | CSS + XPath selector generators with timeouts and a bounded concurrency queue. |
| `src/core/export/` | HTML / CSV / JSON / Excel exporters for both comparisons and saved extractions. |
| `src/infrastructure/` | Renderer-side cross-cutting services: IndexedDB repository (with WAL + circuit breaker), structured logger, error tracker, performance monitor. |
| `src/main/` | Electron main process: app lifecycle, IPC handlers, preload, Playwright manager, custom protocol, resource path resolution. |
| `src/renderer/` | Renderer entry, state machine, application workflows, presentational components, design tokens, stylesheets. |
| `src/renderer/application/` | Workflow orchestration (extract / compare / import / export / report management / notification queue). |
| `src/renderer/components/` | UI: app shell, modal, progress bar, report list (virtual scroll), report combobox, result panel, status bar, system banner, toast, tooltip. |
| `src/renderer/styles/` | `tokens.css` design tokens, plus `base`, `shell`, `components`, `navigation`, `report-list`, `result-panel` stylesheets. |
| `src/renderer/utils/` | Renderer helpers: icons, panel-rail breakpoints, report metadata, sanitize, time. |
| `scripts/` | Build-time guards. `check-env.js` enforces `PLAYWRIGHT_BROWSERS_PATH`; `strip-comments.js` is a developer utility. |
| `docs/` | Optional design notes and migration specs. Not loaded at runtime. |
| `dist/` | Webpack output. Not committed. |
| `release/` | electron-builder output. Not committed. |
| `.playwright-browsers/` | Project-local Playwright browser tree consumed by `electron-builder` `extraResources`. |
| `.github/workflows/` | CI release pipeline definitions. |

Top-level files of note: `webpack.main.config.js`, `webpack.renderer.config.js`,
`webpack.extractor.config.js`, `electron-builder.yml`, `.eslintrc.json`,
`.prettierrc`, `package.json`.

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

Enforcement is currently editorial (not runtime-checked), backed by ESLint and
the webpack alias map (`@core`, `@config`, `@infra`). `madge` is installed as a
devDependency for ad-hoc cycle detection.

See `SYSTEM_REFERENCE.md` → *Architecture* for the diagram with concrete file
paths and what breaks if the rule is violated.

## Electron context map

### Main (Node.js)

- `src/main/index.js` — lifecycle, application menu, frozen-session recovery
- `src/main/ipc-handlers.js` — `ipcMain.handle` registry
- `src/main/playwright-manager.js` — browser launch, extraction, comparison orchestration, CDP screenshots
- `src/main/protocol-handler.js` — `app://` scheme + 512 MB blob LRU
- `src/main/resource-paths.js` — locates extractor bundle / browsers across dev vs packaged
- `src/core/**` — loaded via Node `require` for the comparator

### Preload (isolated Node bridge)

- `src/main/preload.js` — `contextBridge.exposeInMainWorld('electronAPI', …)`
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
metrics, cancellation, progress and notification pushes, native context-menu
and application-menu actions, window-title updates. See
`SYSTEM_REFERENCE.md` → *IPC Registry* for every channel name, direction,
payload type, and handler.

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
  result returns to the renderer via IPC.
- **Renderer is sandboxed.** `app.enableSandbox()` is called in `src/main/index.js`.
  All Node capabilities the renderer needs must come through the preload bridge.
- **Storage degradation events are dispatched on `window`.** Listen for
  `storage-degraded` with `detail.reason` `CIRCUIT_OPEN` (red banner) or
  `WAL_REPLAY_EXHAUSTED` (warning banner). Three consecutive write failures open
  the circuit until the renderer is reloaded.
- **WAL replay attempts are bounded.** Each pending entry tracks `replayCount`;
  after three failed attempts it is marked `FAILED` and the user is banner-warned.
  `SAVE_VISUAL_BLOB` WAL entries are *never* replayed (binary payload may be lost
  in flight) — they are immediately failed on startup.
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
  defensive but currently never finds anything to recover.
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
