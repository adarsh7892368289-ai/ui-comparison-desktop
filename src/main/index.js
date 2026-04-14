'use strict';

const { app, BrowserWindow, protocol, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
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
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => {
          BrowserWindow.getFocusedWindow()?.webContents.send(IPC.MENU_ACTION, 'toggle-sidebar');
        }},
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => {
          shell.openExternal('https://github.com/your-org/ui-comparison/wiki');
        }},
        { label: 'Report an Issue', click: () => {
          shell.openExternal('https://github.com/your-org/ui-comparison/issues');
        }},
        { type: 'separator' },
        { role: 'about' }
      ]
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
        { label: 'Export as Excel', click: () => send({ action: 'export', format: 'excel', reportId }) },
        { label: 'Export as CSV', click: () => send({ action: 'export', format: 'csv', reportId }) },
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

// Lazy getter — app.getPath('userData') must not be called before app.ready
function _stateFilePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function _loadWindowState() {
  try { return JSON.parse(fs.readFileSync(_stateFilePath(), 'utf8')); }
  catch { return null; }
}

function _saveWindowState(win) {
  try {
    const b = win.getBounds();
    fs.writeFileSync(_stateFilePath(), JSON.stringify({
      x: b.x, y: b.y,
      width: b.width, height: b.height,
      maximized: win.isMaximized()
    }));
  } catch (err) {
    log.error('Error saving window state', { err: err.message });
  }
}

// Debounced periodic save — survives OS force-kill (SIGKILL) better than close-only
function _attachPeriodicStateSave(win) {
  let _saveTimer = null;
  const schedSave = () => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => _saveWindowState(win), 800);
  };
  win.on('resize', schedSave);
  win.on('move',   schedSave);
}

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
    backgroundColor: '#111827',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 12, y: 14 },
        }
      : {}),
  });

  win.once('ready-to-show', () => {
    const savedState = _loadWindowState();
    if (!savedState || savedState.maximized) {
      win.maximize();
    } else {
      if (savedState.width && savedState.height) {
        win.setSize(savedState.width, savedState.height);
      }
      if (savedState.x != null && savedState.y != null) {
        win.setPosition(savedState.x, savedState.y);
      }
    }
    win.show();
  });

  win.on('close', () => _saveWindowState(win));
  _attachPeriodicStateSave(win);

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