/**
 * Groups modified elements into the minimum set of scroll keyframes needed to
 * screenshot all of them. A keyframe is a {scrollY, elementIds[]} plan that tells
 * the visual capture pipeline where to scroll before taking one screenshot.
 * Runs in the MV3 service worker context.
 * Invariant: every element in the input appears in exactly one output keyframe.
 * Called by: visual-workflow.js → executeTabCapture().
 */

const KF_PREFIX     = 'kf';
/** px of padding above the first element in an overflow cluster to avoid cropping its top edge. */
const OVERFLOW_PAD  = 40;

/**
 * Clamps a desired scrollY so the viewport never scrolls past the document bottom.
 * When the document is shorter than one viewport the only valid scroll position is 0.
 */
function clampScrollY(raw, viewportHeight, documentHeight) {
  if (documentHeight <= viewportHeight) { return 0; }
  return Math.floor(Math.max(0, Math.min(raw, documentHeight - viewportHeight)));
}

/**
 * Creates an empty cluster anchored to a root HPID segment.
 * `top` starts at Infinity and `bottom` at -Infinity so the first expandCluster
 * call always wins both comparisons without a special-case initialisation check.
 */
function buildCluster(root) {
  return { root, elements: [], top: Infinity, bottom: -Infinity };
}

/** Adds one element to a cluster and expands the cluster's bounding box to include it. */
function expandCluster(cluster, el) {
  cluster.elements.push(el);
  const elTop    = el.documentY;
  const elBottom = el.documentY + el.height;
  if (elTop    < cluster.top)    { cluster.top    = elTop; }
  if (elBottom > cluster.bottom) { cluster.bottom = elBottom; }
}

/** Returns a new keyframe group object with an empty elementIds array. */
function makeGroup(index, scrollY, viewportWidth, viewportHeight) {
  return {
    id: `${KF_PREFIX}_${index}`,
    scrollY,
    viewportWidth,
    viewportHeight,
    elementIds: []
  };
}

/**
 * Pass 1: groups elements by the first segment of their HPID so that elements
 * sharing a common ancestor are clustered together before scroll planning.
 * Returns clusters sorted top-to-bottom by their uppermost element.
 */
function passOne(elements) {
  const clusters = new Map();
  for (const el of elements) {
    const root = el.id.split('.')[0];
    if (!clusters.has(root)) { clusters.set(root, buildCluster(root)); }
    expandCluster(clusters.get(root), el);
  }
  return [...clusters.values()].sort((a, b) => a.top - b.top);
}

/**
 * Pass 2: converts clusters into keyframe groups.
 * A cluster that fits inside one viewport becomes one keyframe centred on it.
 * A cluster taller than the viewport is split into as many keyframes as needed,
 * each packed from the top of the next unassigned element in the cluster.
 */
function passTwo(clusters, viewportHeight, viewportWidth, documentHeight) {
  const groups = [];

  for (const cluster of clusters) {
    const clusterHeight = cluster.bottom - cluster.top;
    const centerY       = (cluster.top + cluster.bottom) / 2;

    if (clusterHeight <= viewportHeight) {
      const scrollY = clampScrollY(
        centerY - viewportHeight / 2,
        viewportHeight,
        documentHeight
      );
      const group = makeGroup(groups.length, scrollY, viewportWidth, viewportHeight);
      for (const el of cluster.elements) { group.elementIds.push(el.id); }
      groups.push(group);

    } else {
      const sorted = [...cluster.elements].sort((a, b) => a.documentY - b.documentY);
      let i = 0;
      while (i < sorted.length) {
        const scrollY       = clampScrollY(sorted[i].documentY - OVERFLOW_PAD, viewportHeight, documentHeight);
        const visibleBottom = scrollY + viewportHeight;
        const group         = makeGroup(groups.length, scrollY, viewportWidth, viewportHeight);
        while (i < sorted.length && sorted[i].documentY < visibleBottom) {
          const el = sorted[i];
          group.elementIds.push(el.id);
          // Log at planning time when an element's bottom edge exceeds this keyframe's
          // viewport boundary. The element stays in this keyframe; captureKeyframe will
          // record it as rectClipped:true. The warn here surfaces the issue before any
          // screenshot is taken so it is visible in the SW log even if the popup is closed.
          if (el.documentY + el.height > visibleBottom) {
            // eslint-disable-next-line no-console
            console.warn(
              `[keyframe-grouper] element ${el.id} bottom (${el.documentY + el.height}px)` +
              ` exceeds keyframe viewport bottom (${visibleBottom}px)` +
              ' — element will be clipped in screenshot'
            );
          }
          i++;
        }
        groups.push(group);
      }
    }
  }

  return groups;
}

/**
 * Entry point: runs pass 1 then pass 2 and returns the final keyframe array.
 * Returns an empty array immediately when there are no elements to capture.
 * @param {object[]} elements      - Usable rect records from inPageGetRects (found && usable).
 * @param {number}   viewportHeight - CSS-px locked viewport height after DevTools bypass.
 * @param {number}   viewportWidth  - CSS-px viewport width.
 * @param {number}   documentHeight - Full document scroll height.
 * @returns {{ id: string, scrollY: number, viewportWidth: number, viewportHeight: number, elementIds: string[] }[]}
 */
function groupIntoKeyframes(elements, viewportHeight, viewportWidth, documentHeight) {
  if (!elements || elements.length === 0) { return []; }
  const clusters = passOne(elements);
  return passTwo(clusters, viewportHeight, viewportWidth, documentHeight);
}

export { groupIntoKeyframes };