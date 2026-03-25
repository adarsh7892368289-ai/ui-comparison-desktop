/**
 * Normalises CSS `font-family` strings to a consistent title-cased format.
 * Runs in the content-script context; pure synchronous string manipulation.
 * Invariant: always returns a string (or the original non-string value unchanged).
 * Called by: normalizer-engine.js for every `font-family` CSS property.
 */

// CSS generic family keywords — left lowercase per the spec, never title-cased.
const GENERIC_FAMILIES = [
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded'
];

// Maps lowercase font names to their conventional display-casing.
// Used before the generic title-case fallback to preserve names like "Comic Sans MS".
const FONT_ALIASES = {
  'arial': 'Arial',
  'helvetica': 'Helvetica',
  'times new roman': 'Times New Roman',
  'times': 'Times',
  'courier new': 'Courier New',
  'courier': 'Courier',
  'verdana': 'Verdana',
  'georgia': 'Georgia',
  'palatino': 'Palatino',
  'garamond': 'Garamond',
  'bookman': 'Bookman',
  'comic sans ms': 'Comic Sans MS',
  'trebuchet ms': 'Trebuchet MS',
  'impact': 'Impact',
  'lucida sans': 'Lucida Sans',
  'tahoma': 'Tahoma',
  'geneva': 'Geneva',
  'monaco': 'Monaco',
  'consolas': 'Consolas'
};

/**
 * Parses a comma-separated `font-family` value and normalises each font name:
 * strips surrounding quotes, lower-cases, applies alias or title-case, then re-joins.
 * Generic family keywords (e.g. `sans-serif`) are preserved in lowercase per spec.
 *
 * @param {string|*} fontFamily - Raw value from a computed `font-family` property.
 * @returns {string} Normalised comma-separated font list, or the original value if not a string.
 */
function normalizeFont(fontFamily) {
  if (!fontFamily || typeof fontFamily !== 'string') {
    return fontFamily;
  }

  const fonts = fontFamily
    .split(',')
    .map(font => font.trim())
    .filter(font => font.length > 0);

  const normalized = fonts.map(font => {
    let cleaned = font.toLowerCase();

    // Remove surrounding single or double quotes added by some browsers.
    cleaned = cleaned.replace(/^['"]|['"]$/g, '');

    cleaned = cleaned.trim();

    if (GENERIC_FAMILIES.includes(cleaned)) {
      return cleaned;
    }

    if (FONT_ALIASES[cleaned]) {
      return FONT_ALIASES[cleaned];
    }

    // Title-case unknown fonts so "open sans" and "Open Sans" compare as equal.
    return cleaned
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  });

  return normalized.join(', ');
}

export { normalizeFont };