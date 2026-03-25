/**
 * Walks the live DOM (light tree + shadow subtrees) and emits ordered element records
 * each carrying a relative HPID path and an absolute HPID path.
 *
 * Execution context: content script.
 * Invariant: shadow boundaries are stamped with a sentinel ordinal (default 0) so HPID strings
 * remain globally unique across host/shadow boundaries. Violating this produces silent
 * cross-capture mismatches in the four-phase matcher.
 *
 * Direct callers: extractor.js
 */

import { get }     from '../../config/defaults.js';
import { getT0Tags } from './element-classifier.js';
import { resolveFilteredRoots, hasActiveFilters } from './extraction-filter.js';

/** Returns the configured shadow-boundary sentinel value (default 0). */
const SHADOW_SENTINEL = () => get('hpid.shadowSentinel', 0);

/**
 * Thrown when DOM depth exceeds the configured sanity limit, preventing infinite
 * recursion on pathological pages with deeply nested shadow trees.
 */
class EngineBoundaryError extends Error {
  /**
   * @param {string} message - Human-readable description of the boundary violation.
   * @param {{ depth: number, tagName: string, hpidPath: number[] }} context - Diagnostic snapshot at the violation point.
   */
  constructor(message, context) {
    super(message);
    this.name    = 'EngineBoundaryError';
    this.context = context;
  }
}

/**
 * Computes an absolute HPID path from `document.body` to `element` by walking
 * `parentElement` and counting preceding siblings at each level.
 * Shadow boundaries inject the sentinel before resuming the host-side ordinal chain.
 *
 * @param {Element} element - Target element.
 * @returns {number[]} Ordered sibling-ordinal path segments from body downward.
 */
function computeAbsoluteHpidPath(element) {
  const path      = [];
  let   current   = element;
  const lightRoot = document.body ?? document.documentElement;

  while (current && current !== lightRoot && current !== document.documentElement) {
    if (current.parentElement) {
      let position = 1;
      let sibling  = current.previousElementSibling;
      while (sibling) {
        position++;
        sibling = sibling.previousElementSibling;
      }
      path.unshift(position);
      current = current.parentElement;
    } else if (current.parentNode instanceof ShadowRoot) {
      const shadowRoot = current.parentNode;
      let position     = 1;
      let sibling      = current.previousElementSibling;
      while (sibling) {
        position++;
        sibling = sibling.previousElementSibling;
      }
      path.unshift(position);
      // Shadow boundary: sentinel separates the in-shadow ordinal from the host ordinal.
      path.unshift(SHADOW_SENTINEL());
      current = shadowRoot.host;
    } else {
      break;
    }
  }

  return path;
}

/**
 * Builds a TreeWalker-compatible node filter that rejects T0 (opaque/excluded) tags
 * and any roots already queued for separate traversal in filtered mode.
 *
 * @param {Set<string>} t0Tags - Uppercase tag names to prune entirely (e.g. SCRIPT, STYLE).
 * @param {WeakSet<Element>|null} excludedRootSet - Roots handled separately; null in full-document mode.
 * @returns {{ acceptNode(node: Element): number }} NodeFilter-compatible object.
 */
function buildNodeFilter(t0Tags, excludedRootSet) {
  return {
    acceptNode(node) {
      if (t0Tags.has(node.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (excludedRootSet !== null && excludedRootSet.has(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  };
}

/**
 * Creates a traversal stack frame for a single DOM node, tracking its depth and HPID paths.
 *
 * @param {Element|ShadowRoot} node - Current node being pushed onto the stack.
 * @param {number} depth - Nesting depth from the traversal root.
 * @param {number[]} hpidPath - Relative HPID path (display-rooted).
 * @param {number[]} absolutePath - Absolute HPID path (document-rooted).
 * @returns {{ node: Element|ShadowRoot, depth: number, hpidPath: number[], absolutePath: number[], childCount: number }}
 */
function createFrame(node, depth, hpidPath, absolutePath) {
  return { node, depth, hpidPath, absolutePath, childCount: 0 };
}

/**
 * Pops stack frames until the top frame owns `parentNode`, re-synchronising the
 * stack after TreeWalker jumps across subtrees.
 * Not using `while (top !== parent)` directly avoids repeated `.node` property reads.
 *
 * @param {Array<object>} stack - Mutable traversal stack (frames from createFrame).
 * @param {Element|ShadowRoot} parentNode - The node that should own the stack top after this call.
 */
function popToParent(stack, parentNode) {
  while (stack.length > 1 && stack[stack.length - 1].node !== parentNode) {
    stack.pop();
  }
}

/**
 * Joins path segments into a dot-separated HPID string (e.g. `1.3.0.2`).
 *
 * @param {number[]} hpidPath - Ordered path segments.
 * @returns {string} Dot-separated HPID string.
 */
function serializeHpid(hpidPath) {
  return hpidPath.join('.');
}

/**
 * Guards against unbounded recursion on pages with extreme DOM depth.
 * Throws `EngineBoundaryError` rather than letting the stack overflow silently.
 *
 * @param {number} depth - Current traversal depth.
 * @param {string} tagName - Tag of the node at this depth (for diagnostics).
 * @param {number[]} parentHpidPath - Parent's HPID path (for diagnostics).
 * @throws {EngineBoundaryError} When `depth` exceeds the configured sanity limit.
 */
function assertDepth(depth, tagName, parentHpidPath) {
  const limit = get('hpid.maxDepth', 5000);
  if (depth > limit) {
    throw new EngineBoundaryError(
      `DOM depth ${depth} exceeded sanity limit of ${limit}`,
      { depth, tagName, hpidPath: parentHpidPath }
    );
  }
}

/**
 * Recursively walks a shadow subtree rooted at `host.shadowRoot`, pushing records into
 * `accumulator`. The shadow root itself is not recorded — only its element descendants.
 * Nested shadow hosts are handled via recursion, not a secondary walker, to keep HPID
 * paths contiguous.
 *
 * @param {Element} host - The shadow host element.
 * @param {number} hostDepth - Depth of the host in the containing traversal.
 * @param {number[]} hostAbsolutePath - Absolute HPID path of the host.
 * @param {number[]} hostRelativePath - Relative HPID path of the host.
 * @param {{ acceptNode(node: Element): number }} nodeFilter - Shared filter (rejects T0 tags).
 * @param {object[]} accumulator - Output array receiving `{ element, depth, hpidPath, absoluteHpidPath }` records.
 */
function collectShadowSubtree(host, hostDepth, hostAbsolutePath, hostRelativePath, nodeFilter, accumulator) {
  const shadowRoot = host.shadowRoot;
  if (!shadowRoot) {return;}

  const sentinel      = SHADOW_SENTINEL();
  const shadowAbsBase = hostAbsolutePath.concat(sentinel);
  const shadowRelBase = hostRelativePath.concat(sentinel);
  const rootFrame     = createFrame(shadowRoot, hostDepth, shadowRelBase, shadowAbsBase);
  const stack         = [rootFrame];
  const walker        = document.createTreeWalker(shadowRoot, NodeFilter.SHOW_ELEMENT, nodeFilter);
  let   node          = walker.nextNode();

  while (node) {
    popToParent(stack, node.parentNode);

    const parentFrame = stack[stack.length - 1];
    parentFrame.childCount += 1;

    const depth       = parentFrame.depth + 1;
    const relHpidPath = parentFrame.hpidPath.concat(parentFrame.childCount);
    const absHpidPath = parentFrame.absolutePath.concat(parentFrame.childCount);

    assertDepth(depth, node.tagName, parentFrame.hpidPath);
    stack.push(createFrame(node, depth, relHpidPath, absHpidPath));

    accumulator.push({
      element:          node,
      depth,
      hpidPath:         relHpidPath,
      absoluteHpidPath: absHpidPath
    });

    if (node.shadowRoot) {
      collectShadowSubtree(node, depth, absHpidPath, relHpidPath, nodeFilter, accumulator);
    }

    node = walker.nextNode();
  }
}

/**
 * Walks the light-DOM subtree under `root`, pushing element records into `accumulator`.
 * Shadow hosts encountered in the light tree delegate their subtrees to `collectShadowSubtree`.
 *
 * @param {Element} root - Light-DOM root to walk (body or a filtered selector root).
 * @param {number[]} rootRelativePath - Display-relative HPID path for `root`.
 * @param {number[]} rootAbsolutePath - Document-absolute HPID path for `root`.
 * @param {{ acceptNode(node: Element): number }} nodeFilter - Shared filter.
 * @param {object[]} accumulator - Output array receiving element records.
 */
function collectLightSubtree(root, rootRelativePath, rootAbsolutePath, nodeFilter, accumulator) {
  const rootFrame = createFrame(root, rootRelativePath.length - 1, rootRelativePath, rootAbsolutePath);
  const stack     = [rootFrame];
  const walker    = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, nodeFilter);
  let   node      = walker.nextNode();

  while (node) {
    popToParent(stack, node.parentNode);

    const parentFrame = stack[stack.length - 1];
    parentFrame.childCount += 1;

    const depth       = parentFrame.depth + 1;
    const relHpidPath = parentFrame.hpidPath.concat(parentFrame.childCount);
    const absHpidPath = parentFrame.absolutePath.concat(parentFrame.childCount);

    assertDepth(depth, node.tagName, parentFrame.hpidPath);
    stack.push(createFrame(node, depth, relHpidPath, absHpidPath));

    accumulator.push({
      element:          node,
      depth,
      hpidPath:         relHpidPath,
      absoluteHpidPath: absHpidPath
    });

    if (node.shadowRoot) {
      collectShadowSubtree(node, depth, absHpidPath, relHpidPath, nodeFilter, accumulator);
    }

    node = walker.nextNode();
  }
}

/**
 * Traverses the entire document starting from `document.body`, with no filter roots.
 * Body is always pushed first with relative path `[1]`; its absolute path is derived
 * from its real position so iframe-hosted pages produce correct absolute HPIDs.
 *
 * @param {Set<string>} t0Tags - Opaque tags to skip entirely.
 * @param {object[]} accumulator - Output array receiving element records.
 */
function traverseFullDocument(t0Tags, accumulator) {
  const body            = document.body ?? document.documentElement;
  const absoluteBodyPath = computeAbsoluteHpidPath(body);
  const displayRootPath = [1];
  const safeAbsPath     = absoluteBodyPath.length > 0 ? absoluteBodyPath : [1];
  const nodeFilter      = buildNodeFilter(t0Tags, null);

  accumulator.push({
    element:          body,
    depth:            0,
    hpidPath:         displayRootPath,
    absoluteHpidPath: safeAbsPath
  });

  collectLightSubtree(body, displayRootPath, safeAbsPath, nodeFilter, accumulator);
}

/**
 * Traverses only the resolved filter roots (e.g. CSS selector matches), assigning each
 * a 1-based relative ordinal. Roots are excluded from each other's sub-walkers via
 * `excludedRootSet` to prevent double-counting when one root is an ancestor of another.
 *
 * @param {Element[]} roots - Ordered list of resolved filter root elements.
 * @param {Set<string>} t0Tags - Opaque tags to skip.
 * @param {object[]} accumulator - Output array receiving element records.
 */
function traverseFilteredRoots(roots, t0Tags, accumulator) {
  const rootSet    = new WeakSet(roots);
  const nodeFilter = buildNodeFilter(t0Tags, rootSet);

  for (let idx = 0; idx < roots.length; idx++) {
    const root             = roots[idx];
    const relPath          = [idx + 1];
    const absoluteHpidPath = computeAbsoluteHpidPath(root);

    accumulator.push({
      element: root,
      depth:   0,
      hpidPath: relPath,
      absoluteHpidPath
    });

    if (root.shadowRoot) {
      collectShadowSubtree(root, 0, absoluteHpidPath, relPath, nodeFilter, accumulator);
    } else {
      collectLightSubtree(root, relPath, absoluteHpidPath, nodeFilter, accumulator);
    }
  }
}

/**
 * Entry point for the extraction pipeline. Dispatches to full-document or filtered traversal
 * based on whether active filters are present, and returns the flat ordered element record list.
 *
 * @param {object} filters - Extraction filter config from the popup (selectors, regions, etc.).
 * @returns {Array<{ element: Element, depth: number, hpidPath: number[], absoluteHpidPath: number[] }>}
 *   Ordered element records; empty array when filters resolve to zero roots.
 */
function traverseDocument(filters) {
  const t0Tags      = getT0Tags();
  const accumulator = [];

  if (!hasActiveFilters(filters)) {
    traverseFullDocument(t0Tags, accumulator);
    return accumulator;
  }

  const roots = resolveFilteredRoots(filters);

  if (!roots || roots.length === 0) {
    return accumulator;
  }

  traverseFilteredRoots(roots, t0Tags, accumulator);
  return accumulator;
}

export { traverseDocument, serializeHpid, computeAbsoluteHpidPath, EngineBoundaryError };