function parseRgba(value) {
  if (typeof value !== 'string') {return null;}
  const m = value.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+))?\s*\)/);
  if (!m) {return null;}
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== null ? Number(m[4]) : 1 };
}

function parsePx(value) {
  if (typeof value !== 'string') {return null;}
  const m = value.match(/^([0-9.]+)px$/);
  return m ? parseFloat(m[1]) : null;
}

function relativeLuminance({ r, g, b }) {
  const toLinear = v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export { parsePx, parseRgba, relativeLuminance };
