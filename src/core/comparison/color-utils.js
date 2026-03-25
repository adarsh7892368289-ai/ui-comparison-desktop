/**
 * Low-level CSS colour and pixel value parsers. Pure functions with no dependencies.
 * Callers: differ.js (parseRgba, parsePx), severity-analyzer.js (relativeLuminance).
 */

/** Parses an rgb() or rgba() string into {r, g, b, a}. Returns null for non-matching input. */
function parseRgba(value) {
  if (typeof value !== 'string') {return null;}
  const m = value.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+))?\s*\)/);
  if (!m) {return null;}
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== null ? Number(m[4]) : 1 };
}

/** Parses a CSS px value string (e.g. "16px") and returns the numeric value. Returns null for non-px input. */
function parsePx(value) {
  if (typeof value !== 'string') {return null;}
  const m = value.match(/^([0-9.]+)px$/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Computes WCAG 2.1 relative luminance for an sRGB colour.
 * The 0.03928 threshold is the linearisation crossover for the sRGB transfer function;
 * the 2.4 exponent is the sRGB gamma. Coefficients (0.2126, 0.7152, 0.0722) are the
 * standard luminance weights for red, green, and blue.
 */
function relativeLuminance({ r, g, b }) {
  const toLinear = v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export { parsePx, parseRgba, relativeLuminance };
