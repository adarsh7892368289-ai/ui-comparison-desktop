'use strict';

const { ipcMain, dialog, app } = require('electron');
const path = require('path');
const fs   = require('fs');
const log  = require('electron-log');

const playwrightManager = require('./playwright-manager');

let _mainWindow = null;
let _blobCache  = null;

function registerIpcHandlers(mainWindow) {
  _mainWindow = mainWindow;
  _registerComparisonHandlers();
  _registerExtractionHandlers();
  _registerFileHandlers();
  _registerBlobHandlers();
  _registerMetaHandlers();
}

function setBlobCache(cache) {
  _blobCache = cache;
}

function _pushToWindow(channel, payload) {
  if (_mainWindow?.webContents && !_mainWindow.webContents.isDestroyed()) {
    _mainWindow.webContents.send(channel, payload);
  }
}

function _registerComparisonHandlers() {
  // Params now include baselineElements/compareElements: renderer loads elements
  // from IDB before this call; main process receives plain objects and runs comparison.
  ipcMain.handle('START_COMPARISON', async (event, params) => {
    const { baselineId, compareId, mode, baselineUrl, compareUrl, baselineElements, compareElements, includeScreenshots } = params;
    log.info('START_COMPARISON', { baselineId, compareId, mode, baselineCount: baselineElements?.length, compareCount: compareElements?.length });

    const sendProgress = (label, pct) => _pushToWindow('COMPARISON_PROGRESS', { label, pct });

    try {
      const result = await playwrightManager.runComparison({
        baselineId,
        compareId,
        mode,
        baselineUrl,
        compareUrl,
        baselineElements,
        compareElements,
        includeScreenshots: includeScreenshots ?? true,
        onProgress: sendProgress,
        blobCache: _blobCache,
      });

      return { success: true, result };

    } catch (error) {
      const msg = error?.message || String(error);
      log.error('START_COMPARISON failed', { error: msg });
      return { success: false, error: msg };
    }
  });
}

function _registerExtractionHandlers() {
  ipcMain.handle('EXTRACT_ELEMENTS', async (event, params) => {
    const { url, browserType, filters } = params;
    log.info('EXTRACT_ELEMENTS', { url, browserType });

    const sendProgress = (label, pct) => _pushToWindow('EXTRACTION_PROGRESS', { label, pct });

    try {
      const report = await playwrightManager.runExtraction({
        url,
        browserType: browserType ?? 'chromium',
        filters,
        onProgress: sendProgress,
      });
      return { success: true, report };
    } catch (error) {
      const msg = error?.message || String(error);
      log.error('EXTRACT_ELEMENTS failed', { error: msg });
      return { success: false, error: msg };
    }
  });
}

function _registerFileHandlers() {
  ipcMain.handle('EXPORT_HTML', async (event, { htmlContent, filename }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(_mainWindow, {
      title:       'Export Comparison Report',
      defaultPath: path.join(app.getPath('downloads'), filename ?? 'comparison-report.html'),
      filters:     [{ name: 'HTML Report', extensions: ['html'] }],
    });

    if (canceled || !filePath) {
      return { success: false, reason: 'cancelled' };
    }

    try {
      await fs.promises.writeFile(filePath, htmlContent, 'utf8');
      log.info('HTML report exported', { filePath });
      return { success: true, filePath };
    } catch (err) {
      log.error('EXPORT_HTML write failed', { error: err.message });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('EXPORT_FILE', async (event, { data, filename, format }) => {
    const extensionMap = { excel: 'xlsx', csv: 'csv', json: 'json' };
    const ext  = extensionMap[format] ?? format;
    const name = filename ?? `export.${ext}`;

    const { canceled, filePath } = await dialog.showSaveDialog(_mainWindow, {
      title:       `Export as ${ext.toUpperCase()}`,
      defaultPath: path.join(app.getPath('downloads'), name),
      filters:     [{ name: ext.toUpperCase(), extensions: [ext] }],
    });

    if (canceled || !filePath) {
      return { success: false, reason: 'cancelled' };
    }

    try {
      const content = (format === 'excel')
        ? Buffer.from(data, 'base64')
        : data;
      await fs.promises.writeFile(filePath, content);
      log.info('File exported', { filePath, format });
      return { success: true, filePath };
    } catch (err) {
      log.error('EXPORT_FILE write failed', { error: err.message });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('IMPORT_FILE', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(_mainWindow, {
      title:      'Import Report File',
      properties: ['openFile'],
      filters:    [
        { name: 'All Supported', extensions: ['json', 'csv', 'xlsx'] },
        { name: 'JSON',  extensions: ['json'] },
        { name: 'CSV',   extensions: ['csv']  },
        { name: 'Excel', extensions: ['xlsx'] },
      ],
    });

    if (canceled || filePaths.length === 0) {
      return { success: false, reason: 'cancelled' };
    }

    const filePath = filePaths[0];
    try {
      const ext  = path.extname(filePath).slice(1).toLowerCase();
      const data = await fs.promises.readFile(filePath);
      const content = (ext === 'xlsx') ? data.toString('base64') : data.toString('utf8');
      return { success: true, content, ext, filename: path.basename(filePath) };
    } catch (err) {
      log.error('IMPORT_FILE read failed', { error: err.message });
      return { success: false, error: err.message };
    }
  });
}

function _registerBlobHandlers() {
  ipcMain.handle('REGISTER_BLOB', (event, { blobId, base64, mimeType }) => {
    if (!_blobCache) {
      log.warn('REGISTER_BLOB: blob cache not initialised');
      return { success: false };
    }
    _blobCache.set(blobId, {
      buffer:   Buffer.from(base64, 'base64'),
      mimeType: mimeType ?? 'image/webp',
    });
    log.debug('Blob registered in protocol cache', { blobId });
    return { success: true };
  });

  ipcMain.handle('UNREGISTER_BLOBS_BY_COMPARISON', (event, comparisonId) => {
    if (!_blobCache) { return { success: false }; }
    let removed = 0;
    for (const [key] of _blobCache) {
      if (key.startsWith(`${comparisonId}:`)) {
        _blobCache.delete(key);
        removed++;
      }
    }
    log.debug('Blobs unregistered from protocol cache', { comparisonId, removed });
    return { success: true, removed };
  });
}

function _registerMetaHandlers() {
  ipcMain.handle('GET_VERSION', () => app.getVersion());
}

module.exports = { registerIpcHandlers, setBlobCache };