export const BULK_EXTRACTED_REPORT_EXPORT_MENU = Object.freeze([
  Object.freeze({ format: 'xlsx', label: 'Excel' }),
  Object.freeze({ format: 'json', label: 'JSON' }),
  Object.freeze({ format: 'csv', label: 'CSV' }),
]);

export const BULK_EXTRACTED_REPORT_EXPORT_FORMAT_LABELS = Object.freeze(
  Object.fromEntries(BULK_EXTRACTED_REPORT_EXPORT_MENU.map((entry) => [entry.format, entry.label]))
);

/** Short codes for toolbar badge when the rail is icon-only (plan: XLSX / CSV / JSON). */
export const BULK_EXTRACTED_REPORT_EXPORT_BADGE_LABELS = Object.freeze({
  xlsx: 'XLSX',
  json: 'JSON',
  csv: 'CSV',
});

export const BULK_EXTRACTED_REPORT_EXPORT_FORMATS = new Set(
  BULK_EXTRACTED_REPORT_EXPORT_MENU.map((entry) => entry.format)
);

export const SINGLE_EXTRACTED_REPORT_EXPORT_MENU = Object.freeze([
  Object.freeze({ format: 'excel', label: 'Excel' }),
  Object.freeze({ format: 'json', label: 'JSON' }),
  Object.freeze({ format: 'csv', label: 'CSV' }),
]);

export const SINGLE_EXTRACTED_REPORT_EXPORT_FORMATS = new Set(
  SINGLE_EXTRACTED_REPORT_EXPORT_MENU.map((entry) => entry.format)
);
