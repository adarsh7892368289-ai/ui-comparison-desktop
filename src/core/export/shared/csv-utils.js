/**
 * Shared CSV formatting utilities used by csv-exporter.js and json-exporter.js.
 * Runs in the popup context (no DOM access required).
 * Called by: csv-exporter.js, json-exporter.js.
 */

const ISO_DATE_SLICE_END = 19;

/**
 * Escapes a single cell value for RFC-4180 CSV output.
 * Prepends a single quote to values that start with formula-injection characters
 * (=, +, -, @) so spreadsheet apps do not evaluate them as formulas.
 * @returns {string} Always a string — never throws.
 */
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

/** Converts a 2D array of values into a newline-joined CSV string with each cell escaped. */
function rowsToCsv(rows) {
  return rows.map(row => row.map(escapeCsv).join(',')).join('\n');
}

/**
 * Returns the current UTC timestamp as a filesystem-safe string (colons and dots replaced with dashes).
 * Used to make export filenames unique without requiring a UUID.
 */
function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-').slice(0, ISO_DATE_SLICE_END);
}

export { escapeCsv, rowsToCsv, safeTimestamp };