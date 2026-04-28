function _splitTopLevel(str, sep) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      buf += ch;
      continue;
    }
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) {
    out.push(buf);
  }
  return out;
}

function _tokenize(str) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      buf += ch;
      continue;
    }
    if (/\s/.test(ch) && depth === 0) {
      if (buf.length > 0) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) {
    out.push(buf);
  }
  return out;
}

function _isLengthToken(token) {
  return /^[-+]?(\d+\.?\d*|\.\d+)([a-z%]+)?$/i.test(token);
}

function _normalizeOneShadow(raw) {
  const tokens = _tokenize(raw);
  if (tokens.length === 0) {
    return null;
  }

  let inset = false;
  const lengths = [];
  const colors = [];

  for (const token of tokens) {
    if (token.toLowerCase() === 'inset') {
      inset = true;
      continue;
    }
    if (_isLengthToken(token)) {
      lengths.push(token);
      continue;
    }
    colors.push(token);
  }

  if (lengths.length < 2) {
    return null;
  }

  const offsetX = lengths[0];
  const offsetY = lengths[1];
  const blur    = lengths[2] ?? '0px';
  const spread  = lengths[3] ?? '0px';
  const color   = colors.join(' ');

  const parts = [];
  if (inset) {
    parts.push('inset');
  }
  parts.push(offsetX, offsetY, blur, spread);
  if (color) {
    parts.push(color);
  }
  return parts.join(' ');
}

function normalizeShadow(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return 'none';
  }
  const shadows = _splitTopLevel(trimmed, ',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const normalized = shadows
    .map(_normalizeOneShadow)
    .filter((s) => s !== null);
  if (normalized.length === 0) {
    return value;
  }
  return normalized.join(', ');
}

export { normalizeShadow };
