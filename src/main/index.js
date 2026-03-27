'use strict';

const { app, BrowserWindow, protocol, nativeTheme } = require('electron');
const path = require('path');
const log  = require('electron-log');

const { registerIpcHandlers, setBlobCache } = require('./ipc-handlers');
const { registerProtocolHandler, blobCache } = require('./protocol-handler');
const { shutdownPlaywright }                 = require('./playwright-manager');

// Config and validator run in main process via webpack-bundled ESM→CJS output
const { init: configInit, get: configGet } = require('../config/defaults');
const { validateConfig }                   = require('../config/validator');


app.commandLine.appendSwitch('--disable-web-security', false);
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

  // 0.4: config.init() before registerIpcHandlers() — any handler that constructs a
  // Comparator or ComparisonMode reads config at construction time; an uninitialized
  // config object returns stale defaults or throws, silently corrupting comparison parameters
  configInit();

  // validateConfig(throwOnError:true) at boot — on throw, quit immediately rather than
  // running with a broken config that produces wrong comparison results silently;
  // throwOnError:false is correct only in non-critical paths (e.g. a settings UI that
  // wants to surface errors to the user without crashing the app)
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
    setBlobCache(blobCache);

    _handlersRegistered = true;
  }

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
    backgroundColor: '#1a1a2e',
  });

  win.once('ready-to-show', () => win.show());

  win.loadURL('app://./index.html');

  if (process.env.NODE_ENV !== 'production') {
    win.webContents.openDevTools({ mode: 'right' });
  }

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