'use strict';

const fs   = require('fs');
const path = require('path');

const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;

if (!browsersPath) {
  console.error('[check-env] FAIL: PLAYWRIGHT_BROWSERS_PATH is not set.');
  console.error('  Windows: set PLAYWRIGHT_BROWSERS_PATH=C:\\playwright-browsers');
  console.error('  macOS/Linux: export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers');
  process.exit(1);
}

const resolved = path.resolve(browsersPath);

if (!fs.existsSync(resolved)) {
  console.error(`[check-env] FAIL: PLAYWRIGHT_BROWSERS_PATH does not exist on disk: ${resolved}`);
  process.exit(1);
}

let chromiumDir;
try {
  chromiumDir = fs.readdirSync(resolved).find(e => e.startsWith('chromium'));
} catch (err) {
  console.error(`[check-env] FAIL: Cannot read PLAYWRIGHT_BROWSERS_PATH: ${err.message}`);
  process.exit(1);
}

if (!chromiumDir) {
  console.error(`[check-env] FAIL: No chromium directory found inside ${resolved}`);
  console.error('  Run: npx playwright install chromium');
  process.exit(1);
}

console.log(`[check-env] OK: chromium found at ${path.join(resolved, chromiumDir)}`);