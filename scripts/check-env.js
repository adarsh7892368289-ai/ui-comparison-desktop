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

const saucectlBinDir = path.resolve(__dirname, '..', '.saucectl-bin');
const platformMap = { win32: 'win', darwin: 'mac', linux: 'linux' };
const osDir = platformMap[process.platform] || process.platform;
const arch = process.arch;
const binaryName = process.platform === 'win32' ? 'saucectl.exe' : 'saucectl';
const expectedBin = path.join(saucectlBinDir, osDir, arch, binaryName);

if (!fs.existsSync(expectedBin)) {
  console.warn(`[check-env] WARN: saucectl binary not found at ${expectedBin}`);
  console.warn('  The packaged app will not include a bundled saucectl (Level 2 fallback skipped).');
  console.warn('  See .saucectl-bin/README.md for instructions on obtaining the binary.');
} else {
  console.log(`[check-env] OK: saucectl binary found at ${expectedBin}`);
}