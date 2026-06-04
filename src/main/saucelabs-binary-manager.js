'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app } = require('electron');
const { spawn } = require('child_process');
const log = require('electron-log');

const PLATFORM_BINARY = process.platform === 'win32' ? 'saucectl.exe' : 'saucectl';

const ASSET_MAP = {
  'win32:x64': (v) => `saucectl_${v}_win_64-bit.zip`,
  'darwin:x64': (v) => `saucectl_${v}_mac_64-bit.tar.gz`,
  'darwin:arm64': (v) => `saucectl_${v}_mac_arm64.tar.gz`,
  'linux:x64': (v) => `saucectl_${v}_linux_64-bit.tar.gz`,
  'linux:arm64': (v) => `saucectl_${v}_linux_arm64.tar.gz`
};

let _resolvedPath = null;
let _resolvedVersion = null;
let _updateCheckDone = false;

function _downloadedBinDir() {
  return path.join(app.getPath('userData'), 'saucectl', 'bin');
}

function _downloadedBinPath() {
  return path.join(_downloadedBinDir(), PLATFORM_BINARY);
}

function _bundledBinPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'saucectl', PLATFORM_BINARY);
  }
  return path.join(app.getAppPath(), 'resources', 'saucectl', PLATFORM_BINARY);
}

function _findOnPath() {
  const envPath = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = envPath.split(sep).filter(Boolean);

  const candidates = process.platform === 'win32' ?
  [PLATFORM_BINARY, 'saucectl.cmd', 'saucectl'] :
  [PLATFORM_BINARY];

  for (const dir of dirs) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
        return candidate;
      } catch {
        void 0;
      }
    }
  }
  return null;
}

function _resolveCmdTarget(cmdPath) {
  try {
    const content = fs.readFileSync(cmdPath, 'utf8');
    const cmdDir = path.dirname(cmdPath);

    const candidates = [];
    const dp0Matches = content.matchAll(/%(?:~dp0|dp0)%[\\/]([^"*?<>|%\r\n]+)/gi);
    for (const m of dp0Matches) {
      const relPath = m[1].replace(/"/g, '').trim();
      const resolved = path.resolve(cmdDir, relPath);
      if (fs.existsSync(resolved)) {
        candidates.push(resolved);
      } else if (!path.extname(resolved) && fs.existsSync(resolved + '.js')) {
        candidates.push(resolved + '.js');
      }
    }

    const isInterpreter = (p) => /[\\/](?:node|electron|deno|bun)\.exe$/i.test(p);
    const jsCandidate = candidates.find((c) => c.toLowerCase().endsWith('.js'));
    if (jsCandidate) return jsCandidate;
    const scriptCandidate = candidates.find((c) => !isInterpreter(c));
    if (scriptCandidate) return scriptCandidate;

    const nodeMatch = content.match(/node(?:\.exe)?["']?\s+["']([^"']+)["']/i);
    if (nodeMatch) {
      const scriptPath = nodeMatch[1].replace(/^%(?:~dp0|dp0)%[\\/]?/i, '');
      const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(cmdDir, scriptPath);
      if (fs.existsSync(resolved)) return resolved;
    }

    return null;
  } catch {
    return null;
  }
}

function _findNativeBinaryNearJsTarget(jsTarget) {
  let dir = path.dirname(jsTarget);
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, 'bin', PLATFORM_BINARY);
    try {
      fs.accessSync(candidate, fs.constants.F_OK);
      return candidate;
    } catch {
      void 0;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function _resolveSpawnCommand(binPath) {
  if (process.platform !== 'win32') {
    return { executable: binPath, prefixArgs: [], env: null };
  }

  const ext = path.extname(binPath).toLowerCase();

  if (ext === '.exe') {
    return { executable: binPath, prefixArgs: [], env: null };
  }

  if (ext === '.cmd' || ext === '.bat') {
    const target = _resolveCmdTarget(binPath);
    if (target) {
      const native = _findNativeBinaryNearJsTarget(target);
      if (native) {
        return { executable: native, prefixArgs: [], env: null };
      }
      return {
        executable: process.execPath,
        prefixArgs: [target],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      };
    }
    const cmdDir = path.dirname(binPath);
    const fallbacks = [
      path.join(cmdDir, 'node_modules', 'saucectl', 'bin', PLATFORM_BINARY),
      path.join(cmdDir, 'node_modules', 'saucectl', 'bin', 'saucectl.js'),
      path.join(cmdDir, 'node_modules', 'saucectl', 'index.js'),
      path.join(cmdDir, '..', 'lib', 'node_modules', 'saucectl', 'bin', PLATFORM_BINARY),
      path.join(cmdDir, '..', 'lib', 'node_modules', 'saucectl', 'bin', 'saucectl.js')
    ];
    for (const fb of fallbacks) {
      if (fs.existsSync(fb)) {
        if (fb.toLowerCase().endsWith('.exe')) {
          return { executable: fb, prefixArgs: [], env: null };
        }
        return {
          executable: process.execPath,
          prefixArgs: [fb],
          env: { ELECTRON_RUN_AS_NODE: '1' }
        };
      }
    }
  }

  if (ext === '.ps1') {
    return {
      executable: 'powershell.exe',
      prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', binPath],
      env: null
    };
  }

  return { executable: binPath, prefixArgs: [], env: null };
}

function _getVersionFromBinary(binPath, timeoutMs) {
  return new Promise((resolve) => {
    let output = '';
    let killed = false;

    const { executable, prefixArgs, env: extraEnv } = _resolveSpawnCommand(binPath);
    const proc = spawn(executable, [...prefixArgs, '--version'], {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    proc.stderr.on('data', () => { void 0; });

    proc.on('error', () => {
      clearTimeout(timer);
      if (!killed) resolve(null);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        resolve(null);
        return;
      }
      const match = output.match(/(\d+\.\d+\.\d+)/);
      resolve(match ? match[1] : null);
    });
  });
}

function _parseSemver(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function _satisfiesRange(version, range) {
  const ver = _parseSemver(version);
  if (!ver) return false;

  const parts = range.trim().split(/\s+/);
  for (const part of parts) {
    const m = part.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/);
    if (!m) return false;
    const op = m[1] || '=';
    const target = _parseSemver(m[2]);
    if (!target) return false;

    const cmp = _compareSemver(ver, target);
    switch (op) {
      case '>=':if (cmp < 0) return false;break;
      case '<=':if (cmp > 0) return false;break;
      case '>':if (cmp <= 0) return false;break;
      case '<':if (cmp >= 0) return false;break;
      case '=':if (cmp !== 0) return false;break;
    }
  }
  return true;
}

function _compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

async function resolveBinaryPath(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;

  const downloaded = _downloadedBinPath();
  try {
    fs.accessSync(downloaded, fs.constants.X_OK);
    const ver = await _getVersionFromBinary(downloaded, timeoutMs);
    if (ver) {
      _resolvedPath = downloaded;
      _resolvedVersion = ver;
      log.info('[SauceBinary] resolved: downloaded', { path: downloaded, version: ver });
      return downloaded;
    }
  } catch {
    void 0;
  }

  const bundled = _bundledBinPath();
  try {
    fs.accessSync(bundled, fs.constants.X_OK);
    const ver = await _getVersionFromBinary(bundled, timeoutMs);
    if (ver) {
      _resolvedPath = bundled;
      _resolvedVersion = ver;
      log.info('[SauceBinary] resolved: bundled', { path: bundled, version: ver });
      return bundled;
    }
  } catch {
    void 0;
  }

  const systemBin = _findOnPath();
  if (systemBin) {
    const ver = await _getVersionFromBinary(systemBin, timeoutMs);
    if (ver) {
      _resolvedPath = systemBin;
      _resolvedVersion = ver;
      log.info('[SauceBinary] resolved: PATH', { path: systemBin, version: ver });
      return systemBin;
    }
  }

  _resolvedPath = null;
  _resolvedVersion = null;
  log.warn('[SauceBinary] no functional binary found at any level');
  return null;
}

function getResolvedPath() {
  return _resolvedPath;
}

function getResolvedVersion() {
  return _resolvedVersion;
}

async function runUpdateCheck(compatibleRange, opts = {}) {
  if (_updateCheckDone) return;
  _updateCheckDone = true;

  const hasActiveJobs = opts.hasActiveJobs ?? (() => false);
  if (hasActiveJobs()) {
    log.info('[SauceBinary] update deferred — active jobs');
    _updateCheckDone = false;
    return;
  }

  let releaseData;
  try {
    releaseData = await _fetchLatestRelease();
  } catch (err) {
    log.warn('[SauceBinary] update check failed: release fetch', { error: err.message });
    return;
  }

  const tagName = releaseData.tag_name ?? '';
  const latestVersion = tagName.replace(/^v/, '');
  if (!_parseSemver(latestVersion)) {
    log.warn('[SauceBinary] update check: unparseable tag', { tagName });
    return;
  }

  if (!_satisfiesRange(latestVersion, compatibleRange)) {
    log.info('[SauceBinary] latest release outside compatible range', { latestVersion, compatibleRange });
    return;
  }

  if (_resolvedVersion && _compareSemver(
    _parseSemver(latestVersion),
    _parseSemver(_resolvedVersion)
  ) <= 0) {
    log.info('[SauceBinary] already at latest compatible version', { current: _resolvedVersion, latest: latestVersion });
    return;
  }

  const platformKey = `${process.platform}:${process.arch}`;
  const assetFn = ASSET_MAP[platformKey];
  if (!assetFn) {
    log.warn('[SauceBinary] unsupported platform for auto-update', { platformKey });
    return;
  }

  const assetFilename = assetFn(latestVersion);
  const asset = (releaseData.assets ?? []).find((a) => a.name === assetFilename);
  if (!asset) {
    log.warn('[SauceBinary] asset not found in release', { assetFilename });
    return;
  }

  try {
    await _downloadAndInstall(latestVersion, asset.browser_download_url, assetFilename);
    log.info('[SauceBinary] update complete', { from: _resolvedVersion, to: latestVersion });
    _resolvedVersion = latestVersion;
    _resolvedPath = _downloadedBinPath();
  } catch (err) {
    log.warn('[SauceBinary] update failed', { error: err.message });
  }
}

async function _fetchLatestRelease() {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/saucelabs/saucectl/releases/latest',
      headers: { 'User-Agent': 'ui-comparison-desktop' }
    };
    if (process.env.GITHUB_TOKEN) {
      options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }
    const req = https.get(options, (res) => {
      if (res.statusCode === 403 || res.statusCode === 429) {
        reject(new Error(`GitHub rate limited: ${res.statusCode}`));
        res.resume();
        return;
      }
      if (res.statusCode === 301 || res.statusCode === 302) {
        reject(new Error(`Unexpected redirect: ${res.statusCode}`));
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (chunk) => {data += chunk;});
      res.on('end', () => {
        try {resolve(JSON.parse(data));}
        catch (e) {reject(e);}
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {req.destroy();reject(new Error('Timeout'));});
  });
}

async function _downloadAndInstall(version, assetUrl, assetFilename) {
  const os = require('os');
  const tmpDir = path.join(os.tmpdir(), `saucectl-update-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const archivePath = path.join(tmpDir, assetFilename);

  try {
    await _downloadFile(assetUrl, archivePath);

    const checksumUrl = `https://github.com/saucelabs/saucectl/releases/download/v${version}/checksums.txt`;
    const checksumPath = path.join(tmpDir, 'checksums.txt');
    await _downloadFile(checksumUrl, checksumPath);

    const checksumContent = fs.readFileSync(checksumPath, 'utf8');
    const expectedHash = _extractHash(checksumContent, assetFilename);
    if (!expectedHash) {
      throw new Error('Checksum entry not found for asset');
    }

    const actualHash = await _computeSha256(archivePath);
    if (actualHash !== expectedHash) {
      fs.unlinkSync(archivePath);
      throw new Error(`Checksum mismatch: expected ${expectedHash}, got ${actualHash}`);
    }

    const binDir = _downloadedBinDir();
    fs.mkdirSync(binDir, { recursive: true });

    const extractedBin = await _extractBinary(archivePath, tmpDir);
    const targetPath = _downloadedBinPath();
    const tmpTarget = targetPath + '.tmp';

    fs.copyFileSync(extractedBin, tmpTarget);
    if (process.platform !== 'win32') {
      fs.chmodSync(tmpTarget, 0o755);
    }
    fs.renameSync(tmpTarget, targetPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function _downloadFile(url, destPath) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl, redirectCount) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const mod = requestUrl.startsWith('https') ? https : http;
      mod.get(requestUrl, { headers: { 'User-Agent': 'ui-comparison-desktop' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          res.resume();
          if (!location) {reject(new Error('Redirect without location'));return;}
          doRequest(location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const stream = fs.createWriteStream(destPath);
        res.pipe(stream);
        stream.on('finish', () => {stream.close(resolve);});
        stream.on('error', (err) => {fs.unlink(destPath, () => {});reject(err);});
      }).on('error', reject);
    };
    doRequest(url, 0);
  });
}

function _extractHash(checksumContent, filename) {
  for (const line of checksumContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[1] === filename) {
      return parts[0].toLowerCase();
    }
  }
  return null;
}

function _computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function _extractBinary(archivePath, tmpDir) {
  const extractDir = path.join(tmpDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  if (archivePath.endsWith('.zip')) {
    await _extractZip(archivePath, extractDir);
  } else {
    await _extractTarGz(archivePath, extractDir);
  }

  const binName = PLATFORM_BINARY;
  const candidates = [
  path.join(extractDir, binName),
  path.join(extractDir, 'saucectl', binName)];


  const found = _findFileRecursive(extractDir, binName);
  if (found) return found;

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(`Binary ${binName} not found in archive`);
}

function _findFileRecursive(dir, filename) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) return full;
    if (entry.isDirectory()) {
      const found = _findFileRecursive(full, filename);
      if (found) return found;
    }
  }
  return null;
}

function _extractZip(zipPath, destDir) {
  const { execFileSync } = require('child_process');
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Expand-Archive -Force -LiteralPath $env:SAUCE_ZIP_PATH -DestinationPath $env:SAUCE_DEST_DIR'
      ],
      { windowsHide: true, env: { ...process.env, SAUCE_ZIP_PATH: zipPath, SAUCE_DEST_DIR: destDir } }
    );
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'ignore' });
  }
  return destDir;
}

function _extractTarGz(tarPath, destDir) {
  const { execFileSync } = require('child_process');
  execFileSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'ignore' });
  return destDir;
}

function resetUpdateFlag() {
  _updateCheckDone = false;
}

module.exports = {
  resolveBinaryPath,
  getResolvedPath,
  getResolvedVersion,
  runUpdateCheck,
  resetUpdateFlag,
  resolveSpawnCommand: _resolveSpawnCommand,
  _satisfiesRange,
  _parseSemver,
  _compareSemver
};