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

function rowsToCsv(rows) {
  return rows.map(row => row.map(escapeCsv).join(',')).join('\n');
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-').slice(0, ISO_DATE_SLICE_END);
}

export { escapeCsv, rowsToCsv, safeTimestamp };