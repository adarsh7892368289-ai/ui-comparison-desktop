import { get }  from '../../config/defaults.js';
import logger   from '../../infrastructure/logger.js';

function collectStylesFromComputed(computedStyle) {
  if (!computedStyle) {
    return Object.create(null);
  }

  const properties = get('extraction.cssProperties');

  try {
    const styles = Object.create(null);
    for (const prop of properties) {
      styles[prop] = computedStyle.getPropertyValue(prop);
    }
    return styles;
  } catch (err) {
    logger.error('Style collection failed', { error: err.message });
    return Object.create(null);
  }
}

export { collectStylesFromComputed };