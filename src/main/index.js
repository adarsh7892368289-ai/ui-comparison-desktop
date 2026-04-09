'use strict';

const { app, BrowserWindow, protocol, nativeTheme } = require('electron');
const path = require('path');
const log  = require('electron-log');

const { registerIpcHandlers, setBlobCache }                        = require('./ipc-handlers');
const { registerProtocolHandler, blobCache, blobCacheSet, blobCacheDelete } = require('./protocol-handler');
const { shutdownPlaywright, recoverFrozenSessions }                = require('./playwright-manager');

const { init: configInit, get: configGet } = require('../config/defaults');
const { validateConfig }                   = require('../config/validator');

app.enableSandbox();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard:        true,
      secure:          true,
      supportFetchAPI: true,
      corsEnabled:     true,
    },
  },
]);

let mainWindow = null;
let _handlersRegistered = false;

app.on('ready', () => {
  log.initialize({ preload: true });
  log.info('App ready — initialising config, window and handlers');

  const isSmokeTest = process.argv.includes('--smoke-test');
  if (isSmokeTest) {
    const fs = require('fs');
    const candidates = [
      path.join(process.resourcesPath ?? '', 'extractor-bundle.js'),
      path.join(__dirname, 'extractor-bundle.js'),
      path.join(process.cwd(), 'dist', 'extractor-bundle.js'),
    ];

    const bundleFound = candidates.some(c => { try { return fs.existsSync(c); } catch { return false; } });
    if (!bundleFound) {
      console.log('[smoke-test] FAIL: extractor-bundle.js not found in candidate paths:');
      for (const c of candidates) { console.log(`  ${c}`); }
      process.exit(1);
    }

    const version = app.getVersion();
    if (!version || typeof version !== 'string' || version.trim() === '') {
      console.log('[smoke-test] FAIL: app.getVersion() returned empty or invalid string');
      process.exit(1);
    }

    console.log(`[smoke-test] PASS: version=${version}`);
    app.quit();
    return;
  }

  configInit();

  try {
    validateConfig({ throwOnError: true });
  } catch (configErr) {
    log.error('[BOOT] Config validation failed — quitting', { error: configErr.message });
    app.quit();
    return;
  }

  log.info('[BOOT] config tolerances:', configGet('comparison.tolerances'));

  registerProtocolHandler();

  mainWindow = createMainWindow();

  if (!_handlersRegistered) {
    registerIpcHandlers(mainWindow);
    setBlobCache(blobCache, blobCacheSet, blobCacheDelete);

    _handlersRegistered = true;
  }

  recoverFrozenSessions()
    .then(n => { if (n > 0) { log.warn('[BOOT] Recovered frozen sessions', { count: n }); } })
    .catch(() => {});

  mainWindow.on('closed', () => { mainWindow = null; });
});

function createMainWindow() {
  const win = new BrowserWindow({
    width:     1280,
    height:    900,
    minWidth:  900,
    minHeight: 600,
    show: false,

    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      true,
    },
    title:           'UI Comparison',
    backgroundColor: '#ffffff',
  });

  win.once('ready-to-show', () => win.show());

  win.loadURL('app://./index.html');

  return win;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
});

app.on('before-quit', async () => {
  log.info('App quitting — shutting down Playwright');
  await shutdownPlaywright().catch(err =>
    log.warn('Playwright shutdown error during quit', { err: err.message })
  );
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception in main process', err);
});