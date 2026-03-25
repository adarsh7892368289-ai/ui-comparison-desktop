import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

let frameworkPatternsCache = null;
function getFrameworkPatterns() {
  if (!frameworkPatternsCache) {
    frameworkPatternsCache = get('attributes.frameworkPatterns').map(p =>
      typeof p === 'string' ? new RegExp(p, 'u') : p
    );
  }
  return frameworkPatternsCache;
}

function collectAttributes(element) {
  try {
    const result   = Object.create(null);
    const patterns = getFrameworkPatterns();

    for (const { name, value } of element.attributes) {
      if (!patterns.some(p => p.test(name))) {
        result[name] = value;
      }
    }

    return result;
  } catch (err) {
    logger.error('Attribute collection failed', { tagName: element.tagName, error: err.message });
    return Object.create(null);
  }
}

export { collectAttributes };