const KF_PREFIX     = 'kf';
const OVERFLOW_PAD  = 40;

function clampScrollY(raw, viewportHeight, documentHeight) {
  if (documentHeight <= viewportHeight) { return 0; }
  return Math.floor(Math.max(0, Math.min(raw, documentHeight - viewportHeight)));
}

function buildCluster(root) {
  return { root, elements: [], top: Infinity, bottom: -Infinity };
}

function expandCluster(cluster, el) {
  cluster.elements.push(el);
  const elTop    = el.documentY;
  const elBottom = el.documentY + el.height;
  if (elTop    < cluster.top)    { cluster.top    = elTop; }
  if (elBottom > cluster.bottom) { cluster.bottom = elBottom; }
}

function makeGroup(index, scrollY, viewportWidth, viewportHeight) {
  return {
    id: `${KF_PREFIX}_${index}`,
    scrollY,
    viewportWidth,
    viewportHeight,
    elementIds: []
  };
}

function passOne(elements) {
  const clusters = new Map();
  for (const el of elements) {
    const root = el.id.split('.')[0];
    if (!clusters.has(root)) { clusters.set(root, buildCluster(root)); }
    expandCluster(clusters.get(root), el);
  }
  return [...clusters.values()].sort((a, b) => a.top - b.top);
}

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
          if (el.documentY + el.height > visibleBottom) {
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

function groupIntoKeyframes(elements, viewportHeight, viewportWidth, documentHeight) {
  if (!elements || elements.length === 0) { return []; }
  const clusters = passOne(elements);
  return passTwo(clusters, viewportHeight, viewportWidth, documentHeight);
}

export { groupIntoKeyframes };
