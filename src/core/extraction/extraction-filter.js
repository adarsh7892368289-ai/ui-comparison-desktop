import logger from '../../infrastructure/logger.js';
function parseClassExpression(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {return null;}

  const groups = trimmed.split(',');
  const selectors = [];

  for (const group of groups) {
    const classes = group.trim().split(/\s+/).filter(Boolean);
    if (classes.length === 0) {continue;}

    const normalized = classes.map(cls => {
      const clean = cls.replace(/^\./u, '');
      return `.${CSS.escape(clean)}`;
    });

    selectors.push(normalized.join(''));
  }

  return selectors.length > 0 ? selectors.join(',') : null;
}

function parseIdExpression(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {return null;}

  const ids = trimmed.split(',').map(i => i.trim()).filter(Boolean);
  if (ids.length === 0) {return null;}

  return ids.map(id => `#${CSS.escape(id.replace(/^#/u, ''))}`).join(',');
}

function parseTagExpression(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {return null;}

  const tags = trimmed.split(/[\s,]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) {return null;}

  return tags.join(',');
}

function buildCombinedSelector(filters) {
  const parts = [
    filters.class ? parseClassExpression(filters.class) : null,
    filters.id    ? parseIdExpression(filters.id)        : null,
    filters.tag   ? parseTagExpression(filters.tag)      : null
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(',') : null;
}

function pruneToTopLevelRoots(candidates) {
  const candidateSet = new WeakSet(candidates);

  return candidates.filter(candidate => {
    let ancestor = candidate.parentElement;
    while (ancestor) {
      if (candidateSet.has(ancestor)) {return false;}
      ancestor = ancestor.parentElement;
    }
    return true;
  });
}

function resolveFilteredRoots(filters) {
  const selector = buildCombinedSelector(filters);

  if (!selector) {
    logger.debug('No valid filter selector — falling back to full document traversal');
    return null;
  }

  let candidates;
  try {
    candidates = Array.from(document.querySelectorAll(selector));
  } catch (err) {
    logger.error('Filter selector failed', { selector, error: err.message });
    return null;
  }

  if (candidates.length === 0) {
    logger.debug('Filter matched zero elements', { selector });
    return [];
  }

  const roots = pruneToTopLevelRoots(candidates);

  logger.debug('Filter roots resolved', {
    selector,
    candidates: candidates.length,
    roots:      roots.length
  });

  return roots;
}

function hasActiveFilters(filters) {
  return Boolean(filters && (filters.class || filters.id || filters.tag));
}

export { resolveFilteredRoots, hasActiveFilters, buildCombinedSelector };