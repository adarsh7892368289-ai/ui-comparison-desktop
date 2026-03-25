import { get } from '../../config/defaults.js';
function formatElementRef(element) {
  let ref = element.tagName.toLowerCase();

  if (element.id) {
    ref += `#${element.id}`;
  }

  if (element.className && typeof element.className === 'string') {
    const maxClasses = get('schema.enrichment.neighbours.maxParentClasses', 3);
    const classes    = element.className.trim().split(/\s+/).slice(0, maxClasses);
    if (classes.length > 0 && classes[0]) {
      ref += `.${classes.join('.')}`;
    }
  }

  return ref;
}

function getChildrenTypes(children) {
  const maxTypes  = get('schema.enrichment.neighbours.maxChildrenTypes', 10);
  const typeCounts = {};

  for (const child of children) {
    const type = child.tagName.toLowerCase();
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  return Object.entries(typeCounts)
    .map(([type, count]) => count > 1 ? `${type}(${count})` : type)
    .slice(0, maxTypes);
}

function getNeighbours(element) {
  const parent          = element.parentElement;
  const previousSibling = element.previousElementSibling;
  const nextSibling     = element.nextElementSibling;
  const { children }    = element;

  return {
    parent:          parent          ? formatElementRef(parent)          : null,
    previousSibling: previousSibling ? formatElementRef(previousSibling) : null,
    nextSibling:     nextSibling     ? formatElementRef(nextSibling)     : null,
    childrenCount:   children ? children.length : 0,
    childrenTypes:   children ? getChildrenTypes(children) : []
  };
}

function getClassHierarchy(element) {
  const maxParentDepth = get('schema.enrichment.classHierarchy.maxParentDepth', 3);
  const maxChildCount  = get('schema.enrichment.classHierarchy.maxChildCount',  10);
  const maxClassSlice  = get('schema.enrichment.classHierarchy.maxClassSlice',  2);
  const hierarchy      = { parentClasses: [], childClasses: [] };

  let current = element.parentElement;
  let depth   = 0;

  while (current && depth < maxParentDepth) {
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/);
      if (classes.length > 0 && classes[0]) {
        hierarchy.parentClasses.push({
          tag:     current.tagName.toLowerCase(),
          classes: classes.slice(0, maxClassSlice)
        });
      }
    }
    current = current.parentElement;
    depth++;
  }

  let counted = 0;
  for (const child of element.children) {
    if (counted >= maxChildCount) {break;}
    if (child.className && typeof child.className === 'string') {
      const classes = child.className.trim().split(/\s+/);
      if (classes.length > 0 && classes[0]) {
        hierarchy.childClasses.push({
          tag:     child.tagName.toLowerCase(),
          classes: classes.slice(0, maxClassSlice)
        });
        counted++;
      }
    }
  }

  return hierarchy;
}

export { getNeighbours, getClassHierarchy, formatElementRef };