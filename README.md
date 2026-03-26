# UI Comparison Desktop

## 📂 Comprehensive Codebase Manifest

This repository follows a strict domain-driven structure. Below is the detailed analysis of every critical file and subsystem included in the project architecture.

### Main Process (Server)

#### 📄 `src/main/playwright-manager.js`
**Role:** The Headless Browser Orchestration Engine

This file acts as the heavy-lifting worker for the main process. It is entirely responsible for launching, managing, and shutting down headless browser instances (Chromium, Firefox, WebKit) using Playwright. It ensures that the environments being compared are strictly controlled and deterministic.

**Key Responsibilities & Capabilities:**
*   **Browser Lifecycle Management:** Manages a cache of active browser connections to optimize performance, preventing the need to spin up a new browser binary for every comparison. It also ensures clean teardowns (`shutdownPlaywright`) to prevent memory leaks.
*   **Time & Animation Freezing:** To ensure zero visual discrepancies caused by animations, this manager injects a CDP (Chrome DevTools Protocol) session to completely halt JavaScript execution and CSS transitions/animations (`freezePage` and `unfreezePage`). 
*   **Intelligent Viewport & Scroll Control:** Before capturing screenshots, it dynamically handles viewport overrides. It detects if DevTools are open (which shrinks the viewport), temporarily overrides the dimensions to mimic a full screen, completely locks scrollbars to prevent shift, and scrolls to specific `y` coordinates to capture off-screen elements.
*   **Visual Data Capture:** Captures high-fidelity (`webp` or `png`) screenshots of specific DOM nodes. It intelligently calculates the bounds of elements (`inPageRemeasureRects`) and groups them into "keyframes" to capture the maximum amount of visual data in the fewest possible screenshots, avoiding image clipping.
*   **Data Extraction & Comparison Execution (`runComparison`):** Orchestrates the end-to-end comparison sequence. It spins up baseline and compare pages, validates if the URLs are compatible, injects the extraction scripts (`content-bundle.js`), extracts the DOM topologies, passes them to the `Comparator` engine, and finally captures the visual keyframes of any modified elements.

#### 📄 `src/main/ipc-handlers.js`
**Role:** The Electron IPC Router and System Integration Hub

This file serves as the strict communication bridge between the secure, isolated Renderer (UI) process and the Node.js Main process. It dictates exactly what actions the UI is permitted to request.

**Key Responsibilities & Capabilities:**
*   **Workflow Orchestration:** Listens for high-level UI commands like `START_COMPARISON` or `EXTRACT_ELEMENTS` and safely delegates them to the `playwright-manager`.
*   **Real-time Progress Streaming:** Acts as a proxy to stream asynchronous progress events back down to the UI window, ensuring loading bars remain completely responsive during heavy headless browser operations.
*   **Native OS Dialogs & File I/O:** Safely invokes native operating system dialogs (`dialog.showSaveDialog`, `dialog.showOpenDialog`). It handles writing HTML, Excel, CSV, or JSON exports straight to the user's local filesystem and securely reading imported historical reports.
*   **Database Integration:** Interfaces with an injected SQLite storage adapter to execute read/write commands like `LOAD_REPORTS`, `DELETE_REPORT`, or fetching cached comparison views.
*   **Memory-Safe Image Proxying:** Exposes `REGISTER_BLOB` channels to catch large screenshot `base64` strings and cache them in-memory as Buffers. This offloads massive payloads from the IPC bridge, allowing the UI to request screenshots securely via a custom `app://` protocol instead of crashing the renderer with memory-heavy string transfers.

### Core Engine Layer

#### 📄 `src/core/comparison/matcher.js`
**Role:** The Heuristic Element Matching Engine

This is one of the most critical and algorithmically complex files in the entire system. Its sole responsibility is to solve the "correspondence problem": given two different DOM trees (baseline and compare), it must intelligently determine which element in the baseline corresponds to which element in the compare tree. This goes far beyond simple ID matching.

**Key Responsibilities & The Multi-Phase Matching Cascade:**
The matcher runs a series of strategies in a specific order of confidence, from most reliable to least reliable. Once an element is matched, it is removed from the pool for subsequent, lower-confidence passes.

1.  **Phase 0: Anchor Attribute Matching:** The highest-confidence pass. It looks for exact matches on stable, developer-provided test attributes (e.g., `data-testid`, `data-cy`). An element with a unique matching test ID is considered an unbreakable "anchor" point.
2.  **Phase 1: Sequence Alignment:** This is the core of the structural analysis. It treats the two lists of elements like lines in a code file and performs a diff-like sequence alignment.
    *   It walks through both lists simultaneously, matching elements that have the same tag and the same Hierarchical Path ID (HPID).
    *   If it finds a mismatch, it uses a `lookAheadWindow` to "search forward" for the next point of synchronization, correctly identifying blocks of purely added or removed elements in between.
3.  **Phase 2: Suffix Re-alignment:** After sequence alignment, some elements might be "orphaned" (e.g., an element was moved to a different parent). This pass attempts to re-match them by looking only at the *suffix* of their HPID. This correctly identifies an element that has moved but maintained its local structure relative to its direct parent.
4.  **Phase 3: Fallback Heuristics:** For any elements that are still unmatched, it runs a final cascade of fallback strategies:
    *   **Absolute HPID:** Matches elements with identical, full HPIDs that were missed by sequence alignment.
    *   **HTML `id` Attribute:** Matches based on the standard `id` attribute.
    *   **CSS Selector / XPath:** Matches elements that have an identical, unique CSS selector or XPath.
    *   **Positional Grid:** A last resort that matches elements of the same tag name that are in a similar geometric position on the page.
5.  **Ambiguity Resolution:** If any strategy (especially the fallbacks) finds multiple potential candidates for a single baseline element, it flags the match as "ambiguous" rather than making a potentially incorrect definitive match.

#### 📄 `src/core/comparison/comparator.js`
**Role:** The Comparison Workflow Orchestrator

If the `matcher.js` decides *which* elements to compare, the `comparator.js` is the manager that oversees the entire operation from start to finish. It delegates the structural matching to the Matcher, and then delegates the property diffing to the specific Diffing Mode logic.

**Key Responsibilities & Capabilities:**
*   **Workflow Delegation:** Acts as the bridge between structural matching (`ElementMatcher`) and visual/CSS property diffing (`StaticComparisonMode` or `DynamicComparisonMode`).
*   **Asynchronous Generator Streaming:** Executes the heavy comparison workload entirely via an async generator (`async* compare`). This allows it to yield granular, real-time progress frames (e.g., "Comparing properties... 75%") continuously to the UI without blocking the Node.js event loop.
*   **Result Synthesis:** Aggregates all the raw data—matched pairs, ambiguous candidates, removed elements, added elements, and calculated property diffs—into a massive, standardized `comparisonResult` object. It also computes top-level health metrics like the overall `matchRate` and records the total execution duration.