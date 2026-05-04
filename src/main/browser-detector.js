'use strict';

const path = require('path');
const fs = require('fs');
const child_process = require('child_process');
const log = require('electron-log');

const REG_EXE = process.platform === 'win32' ?
path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'reg.exe') :
null;

const REG_TIMEOUT_MS = 3000;
const VERSION_TIMEOUT_MS = 3000;

let _cache = null;

const PLAYWRIGHT_DESCRIPTOR_IDS = Object.freeze({
  chromium: 'playwright-chromium',
  firefox: 'playwright-firefox',
  webkit: 'playwright-webkit'
});

function _isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function _safeReadVersion(execPath, args) {
  try {
    const r = child_process.spawnSync(execPath, args, {
      timeout: VERSION_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true
    });
    if (r.status !== 0) {return null;}
    const out = (r.stdout ?? '').trim();
    const m = out.match(/(\d+\.\d+(?:\.\d+){0,3})/);
    return m ? m[1] : out || null;
  } catch {
    return null;
  }
}

function _readMacBundleVersion(appPath) {



  try {
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    if (!fs.existsSync(plist)) {return null;}
    const r = child_process.spawnSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print CFBundleShortVersionString', plist],
      { timeout: VERSION_TIMEOUT_MS, encoding: 'utf8' }
    );
    if (r.status === 0) {
      const v = (r.stdout ?? '').trim();
      if (v) {return v;}
    }
  } catch {void 0;}
  try {
    const r = child_process.spawnSync(
      'mdls', ['-name', 'kMDItemVersion', '-raw', appPath],
      { timeout: VERSION_TIMEOUT_MS, encoding: 'utf8' }
    );
    if (r.status === 0) {
      const v = (r.stdout ?? '').trim().replace(/^"|"$/g, '');
      return v && v !== '(null)' ? v : null;
    }
  } catch {void 0;}
  return null;
}

function _probeRegistry(keyPath, valueName) {
  if (process.platform !== 'win32' || !REG_EXE) {return null;}
  if (!fs.existsSync(REG_EXE)) {
    log.warn('[browser-detector] reg.exe not found at expected path', { REG_EXE });
    return null;
  }
  try {
    const args = ['query', keyPath];
    if (valueName) {args.push('/v', valueName);} else {args.push('/ve');}
    const r = child_process.spawnSync(REG_EXE, args, {
      timeout: REG_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true
    });
    if (r.status !== 0) {return null;}
    return r.stdout ?? null;
  } catch (err) {
    log.debug('[browser-detector] registry probe failed', { keyPath, error: err.message });
    return null;
  }
}

function _parseRegStringValue(stdout) {
  if (!stdout) {return null;}

  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s+(.+)$/);
    if (m) {
      let v = m[1].trim();

      v = v.replace(/^"([^"]+)".*$/, '$1');
      return v;
    }
  }
  return null;
}

async function _resolvePlaywrightPath(browserType) {




  let pw;
  try {
    pw = require('playwright');
  } catch (err) {
    log.warn('[browser-detector] playwright module unavailable', { error: err.message });
    return null;
  }
  const launcher = pw[browserType];
  if (!launcher || typeof launcher.executablePath !== 'function') {return null;}
  try {
    const p = launcher.executablePath();
    if (typeof p === 'string' && p && _isExecutable(p)) {return p;}
    return null;
  } catch (err) {
    log.debug('[browser-detector] executablePath() threw', { browserType, error: err.message });
    return null;
  }
}

async function _detectPlaywrightManaged(browserType, isDefault) {
  const execPath = await _resolvePlaywrightPath(browserType);
  const id = PLAYWRIGHT_DESCRIPTOR_IDS[browserType];
  const isAvailable = execPath != null;
  const displayName = browserType === 'chromium' ? 'Playwright Chromium (bundled)' :
  browserType === 'firefox' ? 'Playwright Firefox (bundled)' :
  'Playwright WebKit (bundled)';
  return {
    id,
    displayName,
    browserType,
    source: 'playwright-managed',
    channel: null,
    executablePath: null,
    version: null,
    isAvailable,
    isLaunchable: isAvailable,
    isDefault: Boolean(isDefault),
    unavailableReason: isAvailable ? null : 'binary-not-found'
  };
}



const MAC_CANONICAL_APPS = [
{ id: 'system-chrome', browserType: 'chromium', channel: 'chrome', app: 'Google Chrome.app', binary: 'Google Chrome', displayName: 'Google Chrome' },
{ id: 'system-edge', browserType: 'chromium', channel: 'msedge', app: 'Microsoft Edge.app', binary: 'Microsoft Edge', displayName: 'Microsoft Edge' },
{ id: 'system-firefox', browserType: 'firefox', channel: null, app: 'Firefox.app', binary: 'firefox', displayName: 'Firefox' },
{ id: 'system-brave', browserType: 'chromium', channel: null, app: 'Brave Browser.app', binary: 'Brave Browser', displayName: 'Brave' },
{ id: 'system-safari', browserType: 'webkit', channel: null, app: 'Safari.app', binary: 'Safari', displayName: 'Safari' }];


function _macAppRoots() {
  const home = process.env.HOME ?? '';
  return [
  '/Applications',
  home ? path.join(home, 'Applications') : null].
  filter(Boolean);
}

function _detectMacBrowsers() {
  const out = [];
  for (const spec of MAC_CANONICAL_APPS) {
    let foundAppPath = null;
    let foundBinaryPath = null;
    for (const root of _macAppRoots()) {
      const appPath = path.join(root, spec.app);
      const binaryPath = path.join(appPath, 'Contents', 'MacOS', spec.binary);
      if (_isExecutable(binaryPath)) {
        foundAppPath = appPath;
        foundBinaryPath = binaryPath;
        break;
      }
    }
    if (!foundBinaryPath) {continue;}
    const version = _readMacBundleVersion(foundAppPath);
    out.push(_buildSystemDescriptor(spec, foundBinaryPath, version));
  }
  return out;
}



const WIN_CANONICAL_PATHS = [

{ id: 'system-chrome', browserType: 'chromium', channel: 'chrome', displayName: 'Google Chrome',
  canonicalSubpaths: ['Google\\Chrome\\Application\\chrome.exe'],
  registryKeys: [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe']

},

{ id: 'system-edge', browserType: 'chromium', channel: 'msedge', displayName: 'Microsoft Edge',
  canonicalSubpaths: ['Microsoft\\Edge\\Application\\msedge.exe'],
  registryKeys: [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe']

},

{ id: 'system-firefox', browserType: 'firefox', channel: null, displayName: 'Firefox',
  canonicalSubpaths: ['Mozilla Firefox\\firefox.exe'],
  registryKeys: [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe']

},

{ id: 'system-brave', browserType: 'chromium', channel: null, displayName: 'Brave',
  canonicalSubpaths: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  registryKeys: [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\brave.exe']

}];


function _winSearchRoots() {



  return [
  process.env.ProgramFiles,
  process.env['ProgramFiles(x86)'],
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  process.env.LOCALAPPDATA].
  filter(Boolean);
}

function _winFileVersion(execPath) {


  try {
    const r = child_process.spawnSync(
      'wmic',
      ['datafile', 'where', `name="${execPath.replace(/\\/g, '\\\\')}"`, 'get', 'Version', '/value'],
      { timeout: VERSION_TIMEOUT_MS, encoding: 'utf8', windowsHide: true }
    );
    if (r.status === 0) {
      const m = (r.stdout ?? '').match(/Version=([\d.]+)/);
      if (m) {return m[1];}
    }
  } catch {void 0;}
  try {
    const psCmd = `(Get-Item -LiteralPath '${execPath.replace(/'/g, "''")}').VersionInfo.ProductVersion`;
    const r = child_process.spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCmd],
      { timeout: VERSION_TIMEOUT_MS, encoding: 'utf8', windowsHide: true }
    );
    if (r.status === 0) {
      const v = (r.stdout ?? '').trim();
      if (v) {return v;}
    }
  } catch {void 0;}
  return null;
}

function _detectWinBrowsers() {
  const out = [];
  for (const spec of WIN_CANONICAL_PATHS) {
    let foundPath = null;
    let foundFromRegistry = false;

    for (const key of spec.registryKeys) {
      const stdout = _probeRegistry(key, null);
      const candidate = _parseRegStringValue(stdout);
      if (candidate && _isExecutable(candidate)) {
        foundPath = candidate;
        foundFromRegistry = true;
        break;
      }
    }

    if (!foundPath) {
      for (const root of _winSearchRoots()) {
        for (const sub of spec.canonicalSubpaths) {
          const candidate = path.join(root, sub);
          if (_isExecutable(candidate)) {
            foundPath = candidate;
            break;
          }
        }
        if (foundPath) {break;}
      }
    }

    if (!foundPath) {continue;}

    const version = _winFileVersion(foundPath);
    const descriptor = _buildSystemDescriptor(spec, foundPath, version);
    if (foundFromRegistry) {
      log.debug('[browser-detector] resolved via registry', { id: spec.id, foundPath });
    }
    out.push(descriptor);
  }
  return out;
}



const LINUX_BROWSERS = [
{ id: 'system-chrome', browserType: 'chromium', channel: 'chrome', displayName: 'Google Chrome',
  binNames: ['google-chrome', 'google-chrome-stable'],
  canonicalAbsPaths: ['/usr/bin/google-chrome', '/opt/google/chrome/google-chrome'] },
{ id: 'system-chromium', browserType: 'chromium', channel: null, displayName: 'Chromium',
  binNames: ['chromium', 'chromium-browser'],
  canonicalAbsPaths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'] },
{ id: 'system-edge', browserType: 'chromium', channel: 'msedge', displayName: 'Microsoft Edge',
  binNames: ['microsoft-edge', 'microsoft-edge-stable'],
  canonicalAbsPaths: ['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge'] },
{ id: 'system-firefox', browserType: 'firefox', channel: null, displayName: 'Firefox',
  binNames: ['firefox', 'firefox-esr'],
  canonicalAbsPaths: ['/usr/bin/firefox', '/usr/bin/firefox-esr', '/snap/bin/firefox'] },
{ id: 'system-brave', browserType: 'chromium', channel: null, displayName: 'Brave',
  binNames: ['brave-browser', 'brave'],
  canonicalAbsPaths: ['/usr/bin/brave-browser', '/opt/brave.com/brave/brave-browser'] }];


function _linuxFindOnPath(binNames) {
  const PATH = process.env.PATH ?? '';
  const dirs = PATH.split(':').filter(Boolean);
  for (const name of binNames) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (_isExecutable(candidate)) {return candidate;}
    }
  }
  return null;
}

function _detectLinuxBrowsers() {
  const out = [];
  for (const spec of LINUX_BROWSERS) {
    let found = null;
    for (const abs of spec.canonicalAbsPaths) {
      if (_isExecutable(abs)) {found = abs;break;}
    }
    if (!found) {
      found = _linuxFindOnPath(spec.binNames);
    }
    if (!found) {continue;}
    const version = _safeReadVersion(found, ['--version']);
    out.push(_buildSystemDescriptor(spec, found, version));
  }
  return out;
}



function _buildSystemDescriptor(spec, foundPath, version) {
  const id = spec.id;
  const browserType = spec.browserType;
  const baseLabel = version ? `${spec.displayName} ${version}` : spec.displayName;





  if (browserType === 'firefox') {
    return {
      id,
      displayName: `${baseLabel} (system — read-only)`,
      browserType,
      source: 'system',
      channel: null,
      executablePath: null,
      version: version ?? null,
      isAvailable: true,
      isLaunchable: false,
      isDefault: false,
      unavailableReason: 'playwright-requires-patched-build'
    };
  }



  if (browserType === 'webkit') {
    return {
      id,
      displayName: `${baseLabel} (read-only)`,
      browserType,
      source: 'system',
      channel: null,
      executablePath: null,
      version: version ?? null,
      isAvailable: true,
      isLaunchable: false,
      isDefault: false,
      unavailableReason: 'playwright-requires-patched-build'
    };
  }





  const useChannel = spec.channel != null && _isCanonicalForChannel(spec.channel, foundPath);

  let isLaunchable = true;
  let unavailableReason = null;
  if (
  process.platform === 'win32' &&
  browserType === 'chromium' &&
  spec.channel === 'chrome' &&
  _isChromeBlockedByDevToolsPolicy())
  {
    isLaunchable = false;
    unavailableReason = 'devtools-blocked-by-policy';
  }

  return {
    id,
    displayName: baseLabel,
    browserType,
    source: 'system',
    channel: useChannel ? spec.channel : null,
    executablePath: useChannel ? null : foundPath,
    version: version ?? null,
    isAvailable: true,
    isLaunchable,
    isDefault: false,
    unavailableReason
  };
}

function _isChromeBlockedByDevToolsPolicy() {
  if (process.platform !== 'win32' || !REG_EXE || !fs.existsSync(REG_EXE)) {
    return false;
  }
  const policyKeys = [
  'HKLM\\SOFTWARE\\Policies\\Google\\Chrome',
  'HKCU\\SOFTWARE\\Policies\\Google\\Chrome'];

  for (const key of policyKeys) {
    try {
      const r = child_process.spawnSync(
        REG_EXE,
        ['query', key, '/v', 'RemoteDebuggingAllowed'],
        { timeout: REG_TIMEOUT_MS, encoding: 'utf8', windowsHide: true }
      );
      if (r.status !== 0) {continue;}
      const out = r.stdout ?? '';
      const m = out.match(/RemoteDebuggingAllowed\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
      if (m && parseInt(m[1], 16) === 0) {
        log.info('[browser-detector] Chrome RemoteDebuggingAllowed=0 detected', { key });
        return true;
      }
    } catch (err) {
      log.debug('[browser-detector] policy probe failed', { key, error: err.message });
    }
  }
  return false;
}

function _isCanonicalForChannel(channel, foundPath) {





  if (!channel) {return false;}
  if (process.platform === 'win32') {
    const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].
    filter(Boolean).map((r) => r.toLowerCase());
    const lp = foundPath.toLowerCase();
    return roots.some((r) => lp.startsWith(r.toLowerCase()));
  }
  if (process.platform === 'darwin') {
    return foundPath.startsWith('/Applications/') ||
    foundPath.startsWith(path.join(process.env.HOME ?? '', 'Applications'));
  }

  return foundPath.startsWith('/usr/bin/') || foundPath.startsWith('/opt/');
}



async function detectBrowsers({ refresh = false } = {}) {
  if (_cache && !refresh) {
    return _cache;
  }

  const start = Date.now();
  const browsers = [];



  browsers.push(await _detectPlaywrightManaged('chromium', true));
  const pwFirefox = await _detectPlaywrightManaged('firefox', false);
  const pwWebkit = await _detectPlaywrightManaged('webkit', false);
  if (pwFirefox.isAvailable) {browsers.push(pwFirefox);}
  if (pwWebkit.isAvailable) {browsers.push(pwWebkit);}


  let systemBrowsers = [];
  try {
    if (process.platform === 'darwin') {
      systemBrowsers = _detectMacBrowsers();
    } else if (process.platform === 'win32') {
      systemBrowsers = _detectWinBrowsers();
    } else if (process.platform === 'linux') {
      systemBrowsers = _detectLinuxBrowsers();
    }
  } catch (err) {
    log.warn('[browser-detector] system probe failed', { error: err.message });
  }
  browsers.push(...systemBrowsers);

  const result = {
    browsers,
    detectedAt: new Date().toISOString()
  };
  _cache = result;

  log.info('[browser-detector] detection complete', {
    count: browsers.length,
    durationMs: Date.now() - start,
    ids: browsers.map((b) => b.id)
  });

  return result;
}

function _resetCache() {
  _cache = null;
}

module.exports = {
  detectBrowsers,
  _resetCache
};