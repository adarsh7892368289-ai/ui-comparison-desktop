'use strict';

const BULK_PAIR_STATE_LABELS = Object.freeze({
  'queued':              'Queued',
  'extracting-baseline': 'Extracting baseline',
  'extracting-compare':  'Extracting compare',
  'matching':            'Matching',
  'screenshots':         'Capturing screenshots',
  'comparing':           'Comparing',
  'persisting':          'Saving',
  'done':                'Done',
  'failed':              'Failed',
  'cancelled':           'Cancelled',
});

const BULK_PAIR_STATE_TOKEN = Object.freeze({
  'queued':              '--color-text-tertiary',
  'extracting-baseline': '--color-brand',
  'extracting-compare':  '--color-brand',
  'matching':            '--color-brand',
  'screenshots':         '--color-brand',
  'comparing':           '--color-brand',
  'persisting':          '--color-brand',
  'done':                '--color-success',
  'failed':              'color-mix(in srgb, var(--color-destructive) 70%, transparent)',
  'cancelled':           '--color-text-tertiary',
});

const BULK_PAIR_ERROR_HINTS = Object.freeze({
  'TIMEOUT':                'The page took too long to respond. Check if the URL is accessible.',
  'CSP_BLOCKED':            'Script injection was blocked. Try a different browser in the selector.',
  'BROWSER_NOT_FOUND':      'The selected browser could not launch. Switch to Playwright Chromium.',
  'BROWSER_POLICY_BLOCKED': "This browser is blocked by your organisation's IT policy. Switch to Playwright Chromium.",
  'INCOMPATIBLE_URLS':      'The two URLs have different paths. Update the plan and re-upload.',
  'STORAGE_DEGRADED':       'Storage stopped accepting writes. Restart the app to recover.',
  'INTERRUPTED':            'This pair was running when the app was last closed. It was marked failed so you can re-run it from the resume banner.',
});

const GENERIC_ERROR_HINT = 'An unexpected error occurred. Check the URL and try again.';

function getErrorHint(errorCode) {
  if (typeof errorCode !== 'string' || errorCode.length === 0) {
    return GENERIC_ERROR_HINT;
  }
  return BULK_PAIR_ERROR_HINTS[errorCode] ?? GENERIC_ERROR_HINT;
}

module.exports = {
  BULK_PAIR_STATE_LABELS,
  BULK_PAIR_STATE_TOKEN,
  BULK_PAIR_ERROR_HINTS,
  getErrorHint,
};
