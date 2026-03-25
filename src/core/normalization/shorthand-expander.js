/**
 * Expands CSS shorthand properties (margin, padding, border, background, font)
 * into their individual longhand equivalents before value normalisation.
 * Runs in the content-script context; pure synchronous object manipulation.
 * Invariant: longhands already present in the input are never overwritten.
 * Called by: normalizer-engine.js before per-property normalisation.
 */

// Maps each supported shorthand to the longhands it expands into, in CSS declaration order.
const SHORTHAND_PROPERTIES = {
  'margin':        ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  'padding':       ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  'border-width':  ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style':  ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color':  ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']
};

// These keys are deleted from the output so the normaliser only sees longhands.
const SHORTHAND_KEYS_TO_DROP = new Set([
  'margin', 'padding',
  'border-width', 'border-style', 'border-color', 'border-radius',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'background', 'font'
]);

/**
 * Main entry point: shallow-copies `styles`, expands all known shorthands into longhands,
 * then deletes the shorthand keys. Returns the expanded map.
 *
 * @param {Record<string, string>} styles - Raw computed-style map (not mutated).
 * @returns {Record<string, string>} New map with only longhand properties.
 */
function expandShorthands(styles) {
  const expanded = { ...styles };

  for (const [shorthand, longhands] of Object.entries(SHORTHAND_PROPERTIES)) {
    if (expanded[shorthand]) {
      const longhandValues = expandShorthandValue(expanded[shorthand], longhands.length);
      for (let i = 0; i < longhands.length; i++) {
        if (!expanded[longhands[i]]) {
          expanded[longhands[i]] = longhandValues[i];
        }
      }
    }
  }

  if (expanded.border) {
    expandBorderShorthand(expanded);
  }

  if (expanded.background) {
    expandBackgroundShorthand(expanded);
  }

  if (expanded.font) {
    expandFontShorthand(expanded);
  }

  for (const key of SHORTHAND_KEYS_TO_DROP) {
    delete expanded[key];
  }

  return expanded;
}

/**
 * Applies the CSS 1-2-3-4 value repetition rules to produce exactly `count` longhand values.
 * Only handles space-separated shorthand values (not slash-separated like `border-radius` corners).
 *
 * @param {string} value - Raw shorthand value string.
 * @param {number} count - Number of longhands to fill (typically 4).
 * @returns {string[]} Array of `count` individual values.
 */
function expandShorthandValue(value, count) {
  const parts = value.trim().split(/\s+/);

  if (count === 4) {
    if (parts.length === 1) {return [parts[0], parts[0], parts[0], parts[0]];}
    if (parts.length === 2) {return [parts[0], parts[1], parts[0], parts[1]];}
    if (parts.length === 3) {return [parts[0], parts[1], parts[2], parts[1]];}
    return parts.slice(0, 4);
  }

  return parts.slice(0, count);
}

/**
 * Expands the `border` shorthand into width, style, and colour longhands.
 * Tokens are classified by pattern: numeric/keyword → width, style keyword → style, rest → color.
 * Mutates `styles` in place; skips any longhand already present.
 *
 * @param {Record<string, string>} styles - Expanded styles map being built.
 */
function expandBorderShorthand(styles) {
  const { border } = styles;
  if (!border) {return;}

  const parts = border.split(/\s+/);
  let width, style, color;

  for (const part of parts) {
    if (/^\d/.test(part) || part === 'thin' || part === 'medium' || part === 'thick') {
      width = part;
    } else if (['none','hidden','dotted','dashed','solid','double','groove','ridge','inset','outset'].includes(part)) {
      style = part;
    } else {
      color = part;
    }
  }

  if (width && !styles['border-top-width']) {
    const widths = expandShorthandValue(width, 4);
    styles['border-top-width']    = widths[0];
    styles['border-right-width']  = widths[1];
    styles['border-bottom-width'] = widths[2];
    styles['border-left-width']   = widths[3];
  }

  if (style && !styles['border-top-style']) {
    styles['border-top-style']    = style;
    styles['border-right-style']  = style;
    styles['border-bottom-style'] = style;
    styles['border-left-style']   = style;
  }

  if (color && !styles['border-top-color']) {
    styles['border-top-color']    = color;
    styles['border-right-color']  = color;
    styles['border-bottom-color'] = color;
    styles['border-left-color']   = color;
  }
}

/**
 * Extracts `background-color` and `background-image` from the `background` shorthand via regex.
 * Best-effort: complex gradients or multi-background values may not parse correctly.
 * Mutates `styles` in place; skips longhands already present.
 *
 * @param {Record<string, string>} styles - Expanded styles map being built.
 */
function expandBackgroundShorthand(styles) {
  const bg = styles.background;
  if (!bg) {return;}

  const colorMatch = bg.match(/(#[0-9a-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-z]+)/i);
  if (colorMatch && !styles['background-color']) {
    styles['background-color'] = colorMatch[0];
  }

  const imageMatch = bg.match(/url\([^)]+\)/);
  if (imageMatch && !styles['background-image']) {
    styles['background-image'] = imageMatch[0];
  }
}

/**
 * Extracts font-style, font-weight, font-size, line-height, and font-family from
 * the `font` shorthand by classifying each space-separated token.
 * Mutates `styles` in place; skips longhands already present.
 *
 * @param {Record<string, string>} styles - Expanded styles map being built.
 */
function expandFontShorthand(styles) {
  const { font } = styles;
  if (!font) {return;}

  const parts = font.split(/\s+/);
  for (const part of parts) {
    if (part === 'italic' || part === 'oblique') {
      if (!styles['font-style']) {styles['font-style'] = part;}
    } else if (part === 'bold' || part === 'bolder' || part === 'lighter' || /^\d{3}$/.test(part)) {
      if (!styles['font-weight']) {styles['font-weight'] = part;}
    } else if (/^\d/.test(part)) {
      const sizeMatch = part.match(/^([^/]+)/);
      if (sizeMatch && !styles['font-size']) {styles['font-size'] = sizeMatch[1];}
      const lineMatch = part.match(/\/(.+)/);
      if (lineMatch && !styles['line-height']) {styles['line-height'] = lineMatch[1];}
    } else if (!styles['font-family']) {
      styles['font-family'] = part;
    }
  }
}

export { expandShorthands };