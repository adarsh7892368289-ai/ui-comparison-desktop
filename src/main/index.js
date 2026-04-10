'use strict';

const { app, BrowserWindow, protocol, Menu, ipcMain } = require('electron');
const path = require('path');
const log  = require('electron-log');

const { registerIpcHandlers, setBlobCache }                        = require('./ipc-handlers');
const { registerProtocolHandler, blobCache, blobCacheSet, blobCacheDelete } = require('./protocol-handler');
const { shutdownPlaywright, recoverFrozenSessions }                = require('./playwright-manager');

const { init: configInit, get: configGet } = require('../config/defaults');
const { validateConfig }                   = require('../config/validator');
const IPC                                  = require('./ipc-channels');

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
let _windowTitleListenerRegistered = false;
let _contextMenuListenerRegistered = false;

function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : [{
          label: 'File',
          submenu: [{ role: 'quit', label: 'Exit' }],
        }]),
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ];

  if (!app.isPackaged) {
    template.push({
      label: 'Developer',
      submenu: [
        { role: 'toggleDevTools' },
        { role: 'reload' },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

  buildApplicationMenu();

  if (!_windowTitleListenerRegistered) {
    ipcMain.on(IPC.SET_WINDOW_TITLE, (event, title) => {
      if (typeof title !== 'string') { return; }
      BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
    });
    _windowTitleListenerRegistered = true;
  }

  if (!_contextMenuListenerRegistered) {
    ipcMain.on(IPC.SHOW_CONTEXT_MENU, (event, payload) => {
      if (!payload || typeof payload.reportId !== 'string') { return; }
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) { return; }
      const { reportId } = payload;
      const send = (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.CONTEXT_ACTION, data);
        }
      };
      const template = [
        { label: 'Set as Baseline', click: () => send({ action: 'setBaseline', reportId }) },
        { label: 'Set as Compare', click: () => send({ action: 'compare', reportId }) },
        { type: 'separator' },
        { label: 'Export as JSON', click: () => send({ action: 'export', format: 'json', reportId }) },
        { label: 'Export as HTML', click: () => send({ action: 'export', format: 'html', reportId }) },
        { type: 'separator' },
        { label: 'Delete', click: () => send({ action: 'delete', reportId }) },
      ];
      Menu.buildFromTemplate(template).popup({ window: win });
    });
    _contextMenuListenerRegistered = true;
  }

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
    /* Match --color-surface-base (tokens.css); avoids white flash before renderer CSS */
    backgroundColor: '#0f1523',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          /* y:14 centers ~12px traffic lights in a 44px toolbar (audit: default y:22 targets 48px) */
          trafficLightPosition: { x: 12, y: 14 },
        }
      : {}),
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