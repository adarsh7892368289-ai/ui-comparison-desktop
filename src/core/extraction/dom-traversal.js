import { get }     from '../../config/defaults.js';
import { getT0Tags } from './element-classifier.js';
import { resolveFilteredRoots, hasActiveFilters } from './extraction-filter.js';

const SHADOW_SENTINEL = () => get('hpid.shadowSentinel', 0);
class EngineBoundaryError extends Error {
  constructor(message, context) {
    super(message);
    this.name    = 'EngineBoundaryError';
    this.context = context;
  }
}

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
      path.unshift(SHADOW_SENTINEL());
      current = shadowRoot.host;
    } else {
      break;
    }
  }

  return path;
}

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

function createFrame(node, depth, hpidPath, absolutePath) {
  return { node, depth, hpidPath, absolutePath, childCount: 0 };
}

function popToParent(stack, parentNode) {
  while (stack.length > 1 && stack[stack.length - 1].node !== parentNode) {
    stack.pop();
  }
}

function serializeHpid(hpidPath) {
  return hpidPath.join('.');
}

function assertDepth(depth, tagName, parentHpidPath) {
  const limit = get('hpid.maxDepth', 5000);
  if (depth > limit) {
    throw new EngineBoundaryError(
      `DOM depth ${depth} exceeded sanity limit of ${limit}`,
      { depth, tagName, hpidPath: parentHpidPath }
    );
  }
}

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