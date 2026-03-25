const GENERIC_FAMILIES = [
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded'
];

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

    cleaned = cleaned.replace(/^['"]|['"]$/g, '');

    cleaned = cleaned.trim();

    if (GENERIC_FAMILIES.includes(cleaned)) {
      return cleaned;
    }

    if (FONT_ALIASES[cleaned]) {
      return FONT_ALIASES[cleaned];
    }

    return cleaned
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  });

  return normalized.join(', ');
}

export { normalizeFont };