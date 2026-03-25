/**
 * Converts any valid CSS color expression into a canonical `rgba(r, g, b, a)` string.
 * Runs in the content-script context; pure synchronous computation, no I/O.
 * Invariant: always returns a string — unknown formats are returned unchanged.
 * Called by: normalizer-engine.js for every color-typed CSS property.
 */

// Static lookup table mapping CSS named colors to their [R, G, B] triplets.
const NAMED_COLORS = {
  aliceblue: [240, 248, 255], antiquewhite: [250, 235, 215], aqua: [0, 255, 255],
  aquamarine: [127, 255, 212], azure: [240, 255, 255], beige: [245, 245, 220],
  bisque: [255, 228, 196], black: [0, 0, 0], blanchedalmond: [255, 235, 205],
  blue: [0, 0, 255], blueviolet: [138, 43, 226], brown: [165, 42, 42],
  burlywood: [222, 184, 135], cadetblue: [95, 158, 160], chartreuse: [127, 255, 0],
  chocolate: [210, 105, 30], coral: [255, 127, 80], cornflowerblue: [100, 149, 237],
  cornsilk: [255, 248, 220], crimson: [220, 20, 60], cyan: [0, 255, 255],
  darkblue: [0, 0, 139], darkcyan: [0, 139, 139], darkgoldenrod: [184, 134, 11],
  darkgray: [169, 169, 169], darkgrey: [169, 169, 169], darkgreen: [0, 100, 0],
  darkkhaki: [189, 183, 107], darkmagenta: [139, 0, 139], darkolivegreen: [85, 107, 47],
  darkorange: [255, 140, 0], darkorchid: [153, 50, 204], darkred: [139, 0, 0],
  darksalmon: [233, 150, 122], darkseagreen: [143, 188, 143], darkslateblue: [72, 61, 139],
  darkslategray: [47, 79, 79], darkslategrey: [47, 79, 79], darkturquoise: [0, 206, 209],
  darkviolet: [148, 0, 211], deeppink: [255, 20, 147], deepskyblue: [0, 191, 255],
  dimgray: [105, 105, 105], dimgrey: [105, 105, 105], dodgerblue: [30, 144, 255],
  firebrick: [178, 34, 34], floralwhite: [255, 250, 240], forestgreen: [34, 139, 34],
  fuchsia: [255, 0, 255], gainsboro: [220, 220, 220], ghostwhite: [248, 248, 255],
  gold: [255, 215, 0], goldenrod: [218, 165, 32], gray: [128, 128, 128],
  grey: [128, 128, 128], green: [0, 128, 0], greenyellow: [173, 255, 47],
  honeydew: [240, 255, 240], hotpink: [255, 105, 180], indianred: [205, 92, 92],
  indigo: [75, 0, 130], ivory: [255, 255, 240], khaki: [240, 230, 140],
  lavender: [230, 230, 250], lavenderblush: [255, 240, 245], lawngreen: [124, 252, 0],
  lemonchiffon: [255, 250, 205], lightblue: [173, 216, 230], lightcoral: [240, 128, 128],
  lightcyan: [224, 255, 255], lightgoldenrodyellow: [250, 250, 210], lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211], lightgreen: [144, 238, 144], lightpink: [255, 182, 193],
  lightsalmon: [255, 160, 122], lightseagreen: [32, 178, 170], lightskyblue: [135, 206, 250],
  lightslategray: [119, 136, 153], lightslategrey: [119, 136, 153], lightsteelblue: [176, 196, 222],
  lightyellow: [255, 255, 224], lime: [0, 255, 0], limegreen: [50, 205, 50],
  linen: [250, 240, 230], magenta: [255, 0, 255], maroon: [128, 0, 0],
  mediumaquamarine: [102, 205, 170], mediumblue: [0, 0, 205], mediumorchid: [186, 85, 211],
  mediumpurple: [147, 112, 219], mediumseagreen: [60, 179, 113], mediumslateblue: [123, 104, 238],
  mediumspringgreen: [0, 250, 154], mediumturquoise: [72, 209, 204], mediumvioletred: [199, 21, 133],
  midnightblue: [25, 25, 112], mintcream: [245, 255, 250], mistyrose: [255, 228, 225],
  moccasin: [255, 228, 181], navajowhite: [255, 222, 173], navy: [0, 0, 128],
  oldlace: [253, 245, 230], olive: [128, 128, 0], olivedrab: [107, 142, 35],
  orange: [255, 165, 0], orangered: [255, 69, 0], orchid: [218, 112, 214],
  palegoldenrod: [238, 232, 170], palegreen: [152, 251, 152], paleturquoise: [175, 238, 238],
  palevioletred: [219, 112, 147], papayawhip: [255, 239, 213], peachpuff: [255, 218, 185],
  peru: [205, 133, 63], pink: [255, 192, 203], plum: [221, 160, 221],
  powderblue: [176, 224, 230], purple: [128, 0, 128], rebeccapurple: [102, 51, 153],
  red: [255, 0, 0], rosybrown: [188, 143, 143], royalblue: [65, 105, 225],
  saddlebrown: [139, 69, 19], salmon: [250, 128, 114], sandybrown: [244, 164, 96],
  seagreen: [46, 139, 87], seashell: [255, 245, 238], sienna: [160, 82, 45],
  silver: [192, 192, 192], skyblue: [135, 206, 235], slateblue: [106, 90, 205],
  slategray: [112, 128, 144], slategrey: [112, 128, 144], snow: [255, 250, 250],
  springgreen: [0, 255, 127], steelblue: [70, 130, 180], tan: [210, 180, 140],
  teal: [0, 128, 128], thistle: [216, 191, 216], tomato: [255, 99, 71],
  turquoise: [64, 224, 208], violet: [238, 130, 238], wheat: [245, 222, 179],
  white: [255, 255, 255], whitesmoke: [245, 245, 245], yellow: [255, 255, 0],
  yellowgreen: [154, 205, 50]
};

/**
 * Entry point: routes a CSS color value to the appropriate parser and returns `rgba(…)`.
 * CSS keywords like `inherit` and `currentcolor` are returned as-is — they cannot be
 * resolved without a live DOM context at comparison time.
 *
 * @param {string|*} color - Raw CSS color value from a computed style.
 * @returns {string} Canonical `rgba(r, g, b, a)` string, or the original value if unrecognised.
 */
function normalizeColor(color) {
  if (!color || typeof color !== 'string') {
    return color;
  }

  const trimmed = color.trim().toLowerCase();

  if (trimmed === 'transparent') {
    return 'rgba(0, 0, 0, 0)';
  }

  if (['currentcolor', 'inherit', 'initial', 'unset', 'revert'].includes(trimmed)) {
    return trimmed;
  }

  if (NAMED_COLORS[trimmed]) {
    const [r, g, b] = NAMED_COLORS[trimmed];
    return `rgba(${r}, ${g}, ${b}, 1)`;
  }

  if (trimmed.startsWith('#')) {
    return hexToRgba(trimmed);
  }

  if (trimmed.startsWith('rgb')) {
    return standardizeRgba(trimmed);
  }

  if (trimmed.startsWith('hsl')) {
    return hslToRgba(trimmed);
  }

  return color;
}

/**
 * Converts 3-, 4-, 6-, or 8-digit hex strings to `rgba(…)`.
 * 3/4-digit hex is expanded by doubling each nibble before parsing.
 *
 * @param {string} hex - Hex color starting with `#`.
 * @returns {string} `rgba(r, g, b, a)` where `a` is in [0, 1].
 */
function hexToRgba(hex) {
  let cleaned = hex.replace('#', '');

  if (cleaned.length === 3) {
    cleaned = cleaned.split('').map(c => c + c).join('');
  }

  if (cleaned.length === 4) {
    cleaned = cleaned.split('').map(c => c + c).join('');
  }

  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);

  let a = 1;
  if (cleaned.length === 8) {
    a = parseInt(cleaned.substring(6, 8), 16) / 255;
    a = Math.round(a * 100) / 100;
  }

  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Normalises `rgb(…)` and `rgba(…)` strings to a consistent `rgba(…)` form.
 * Rounds fractional RGB values so comparisons aren't thrown off by sub-pixel differences.
 *
 * @param {string} rgba - Raw `rgb` or `rgba` string from a computed style.
 * @returns {string} Standardised `rgba(…)` or the original string if regex fails.
 */
function standardizeRgba(rgba) {
  const match = rgba.match(/rgba?\s*\(\s*([^)]+)\s*\)/);
  if (!match) {return rgba;}

  const parts = match[1].split(',').map(p => p.trim());

  const r = Math.round(parseFloat(parts[0]));
  const g = Math.round(parseFloat(parts[1]));
  const b = Math.round(parseFloat(parts[2]));
  const a = parts[3] ? parseFloat(parts[3]) : 1;

  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Converts `hsl(…)` / `hsla(…)` to `rgba(…)` using the standard HLS→RGB algorithm.
 * Clamps saturation and lightness to [0, 1] and wraps hue to [0, 360) before conversion.
 *
 * @param {string} hsl - Raw `hsl` or `hsla` string.
 * @returns {string} `rgba(r, g, b, a)` or the original string if parsing fails.
 */
function hslToRgba(hsl) {
  const match = hsl.match(/hsla?\s*\(\s*([^)]+)\s*\)/);
  if (!match) {return hsl;}

  const parts = match[1].split(',').map(p => p.trim());

  let h = parseFloat(parts[0]);
  let s = parseFloat(parts[1].replace('%', '')) / 100;
  let l = parseFloat(parts[2].replace('%', '')) / 100;
  const a = parts[3] ? parseFloat(parts[3]) : 1;

  h %= 360;
  if (h < 0) {h += 360;}

  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;

  let r, g, b;

  if (h < 60) {
    r = c; g = x; b = 0;
  } else if (h < 120) {
    r = x; g = c; b = 0;
  } else if (h < 180) {
    r = 0; g = c; b = x;
  } else if (h < 240) {
    r = 0; g = x; b = c;
  } else if (h < 300) {
    r = x; g = 0; b = c;
  } else {
    r = c; g = 0; b = x;
  }

  r = Math.round((r + m) * 255);
  g = Math.round((g + m) * 255);
  b = Math.round((b + m) * 255);

  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export { normalizeColor };