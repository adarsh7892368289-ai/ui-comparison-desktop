'use strict';

const { app, BrowserWindow, protocol, nativeTheme } = require('electron');
const path = require('path');
const log  = require('electron-log');

const { registerIpcHandlers, setBlobCache } = require('./ipc-handlers');
const { registerProtocolHandler, blobCache } = require('./protocol-handler');

app.commandLine.appendSwitch('--disable-web-security', false);
app.enableSandbox();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard:       true,
      secure:         true,
      supportFetchAPI: true,
      corsEnabled:    true,
    },
  },
]);

let mainWindow = null;

app.on('ready', () => {
  log.initialize({ preload: true });
  log.info('App ready — initialising window and handlers');

  registerProtocolHandler();

  mainWindow = createMainWindow();

  registerIpcHandlers(mainWindow);
  setBlobCache(blobCache);

  mainWindow.on('closed', () => { mainWindow = null; });
});

function createMainWindow() {
  const win = new BrowserWindow({
    width:  1280,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    show: false,

    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
    title: 'UI Comparison',
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
    registerIpcHandlers(mainWindow);
  }
});

const { shutdownPlaywright } = require('./playwright-manager');
app.on('before-quit', async () => {
  log.info('App quitting — shutting down Playwright');
  await shutdownPlaywright();
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception in main process', err);
});