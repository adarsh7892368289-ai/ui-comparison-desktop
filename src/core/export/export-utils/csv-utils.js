const ISO_DATE_SLICE_END = 19;

function escapeCsv(value) {
  if (value === null || value === undefined)                     { return ''; }
  if (typeof value === 'number' || typeof value === 'boolean')  { return String(value); }

  const str  = String(value);
  const safe = /^[=+\-@]/u.test(str) ? `'${str}` : str;

  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function unescapeCsv(value) {
  if (typeof value !== 'string') { return value; }
  // Reverse escapeCsv's formula-injection guard: a leading apostrophe is only
  // ever prepended when the original value started with =, +, - or @.
  if (value.length >= 2 && value[0] === "'" && /^[=+\-@]/u.test(value.slice(1))) {
    return value.slice(1);
  }
  return value;
}

function rowsToCsv(rows) {
  return rows.map(row => row.map(escapeCsv).join(',')).join('\n');
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-').slice(0, ISO_DATE_SLICE_END);
}

export { escapeCsv, unescapeCsv, rowsToCsv, safeTimestamp };