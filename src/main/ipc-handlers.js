'use strict';

const { ipcMain, dialog, app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const log = require('electron-log');

const CH = require('./ipc-channels');
const playwrightManager = require('./playwright-manager');

let _mainWindow = null;
let _blobCache = null;
let _blobCacheSet = null;
let _blobCacheDelete = null;

const _cancelRegistry = new Map();

function _registerOp(operationId, kind) {
  if (typeof operationId === 'string' && operationId) {
    _cancelRegistry.set(operationId, { cancelled: false, kind });
  }
}

function _unregisterOp(operationId) {
  if (typeof operationId === 'string' && operationId) {
    _cancelRegistry.delete(operationId);
  }
}

function _isCancelled(operationId) {
  return () => !!(operationId && _cancelRegistry.get(operationId)?.cancelled);
}

function registerIpcHandlers(mainWindow) {
  _mainWindow = mainWindow;
  _registerCancelHandlers();
  _registerComparisonHandlers();
  _registerExtractionHandlers();
  _registerFileHandlers();
  _registerBlobHandlers();
  _registerMetaHandlers();
  _registerBrowserHandlers();
}

function _registerCancelHandlers() {
  ipcMain.handle(CH.CANCEL_OPERATION, (event, { operationId } = {}) => {
    const ent = _cancelRegistry.get(operationId);
    if (ent) {ent.cancelled = true;}
    return { acknowledged: true };
  });
}

function setBlobCache(cache, cacheSet, cacheDelete) {
  _blobCache = cache;
  _blobCacheSet = cacheSet;
  _blobCacheDelete = cacheDelete;
}

function _pushToWindow(channel, payload) {
  if (_mainWindow?.webContents && !_mainWindow.webContents.isDestroyed()) {
    _mainWindow.webContents.send(channel, payload);
  }
}

function _registerComparisonHandlers() {
  ipcMain.handle(CH.START_COMPARISON, async (event, params) => {
    const { baselineId, compareId, mode, baselineUrl, compareUrl, baselineElements, compareElements, includeScreenshots, browser, operationId } = params;
    log.info('START_COMPARISON', { baselineId, compareId, mode, baselineCount: baselineElements?.length, compareCount: compareElements?.length, browserType: browser?.browserType });

    _registerOp(operationId, 'compare');
    const sendProgress = (label, pct) =>
    _pushToWindow(CH.COMPARISON_PROGRESS, { label, pct, operationId });

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
        browser,
        onProgress: sendProgress,
        blobCache: _blobCache,
        isCancelled: _isCancelled(operationId)
      });

      return { success: true, result };

    } catch (error) {
      if (error?.code === 'CANCELLED') {
        return { success: false, cancelled: true };
      }
      const msg = error?.message || String(error);
      log.error('START_COMPARISON failed', { error: msg });
      return { success: false, error: msg };
    } finally {
      _unregisterOp(operationId);
    }
  });
}

function _registerExtractionHandlers() {
  ipcMain.handle(CH.EXTRACT_ELEMENTS, async (event, params) => {
    const { url, options, operationId } = params;
    const filters = options?.filters;
    const browser = options?.browser;
    log.info('EXTRACT_ELEMENTS', { url, filters, browserType: browser?.browserType });

    _registerOp(operationId, 'extract');
    const sendProgress = (label, pct) =>
    _pushToWindow(CH.EXTRACTION_PROGRESS, { label, pct, operationId });

    try {
      const report = await playwrightManager.runExtraction({
        url,
        browser,
        filters,
        onProgress: sendProgress,
        isCancelled: _isCancelled(operationId)
      });
      return { success: true, report };
    } catch (error) {
      if (error?.code === 'CANCELLED') {
        return { success: false, cancelled: true };
      }
      const msg = error?.message || String(error);
      log.error('EXTRACT_ELEMENTS failed', { error: msg });
      return { success: false, error: msg };
    } finally {
      _unregisterOp(operationId);
    }
  });
}

function _registerFileHandlers() {
  ipcMain.handle(CH.EXPORT_HTML, async (event, { htmlContent, filename }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(_mainWindow, {
      title: 'Export Comparison Report',
      defaultPath: path.join(app.getPath('downloads'), filename ?? 'comparison-report.html'),
      filters: [{ name: 'HTML Report', extensions: ['html'] }]
    });

    if (canceled || !filePath) {
      return { success: false, reason: 'cancelled' };
    }

    try {
      await fs.promises.writeFile(filePath, htmlContent, 'utf8');
      log.info('HTML report exported', { filePath });
      return { success: true, filePath };
    } catch (err) {
      log.error('EXPORT_HTML write failed', { error: err.message, code: err.code });
      const reason = err.code === 'EACCES' ? 'Permission denied — choose a different location' :
      err.code === 'EBUSY' ? 'File is in use by another process' :
      err.message;
      return { success: false, error: reason };
    }
  });

  ipcMain.handle(CH.EXPORT_FILE, async (event, { data, filename, format }) => {
    const extensionMap = { xlsx: 'xlsx', csv: 'csv', json: 'json' };
    const ext = extensionMap[format] ?? format;
    const name = filename ?? `export.${ext}`;

    const { canceled, filePath } = await dialog.showSaveDialog(_mainWindow, {
      title: `Export as ${ext.toUpperCase()}`,
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    });

    if (canceled || !filePath) {
      return { success: false, reason: 'cancelled' };
    }

    try {
      let content;
      if (data instanceof Uint8Array) {
        content = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else if (data instanceof ArrayBuffer) {
        content = Buffer.from(data);
      } else if (Array.isArray(data)) {
        content = Buffer.from(data);
      } else {
        content = data;
      }
      await fs.promises.writeFile(filePath, content);
      log.info('File exported', { filePath, format });
      return { success: true, filePath };
    } catch (err) {
      log.error('EXPORT_FILE write failed', { error: err.message, code: err.code });
      const reason = err.code === 'EACCES' ? 'Permission denied — choose a different location' :
      err.code === 'EBUSY' ? 'File is in use by another process' :
      err.message;
      return { success: false, error: reason };
    }
  });

  ipcMain.handle(CH.OPEN_REPORT, async (event, { htmlContent }) => {
    const tempPath = path.join(os.tmpdir(), `ui-comparison-report-${crypto.randomUUID()}.html`);
    try {
      await fs.promises.writeFile(tempPath, htmlContent, 'utf8');
      const win = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      win.on('closed', () => fs.unlink(tempPath, () => {}));
      await win.loadFile(tempPath);
      win.setTitle('UI Comparison Report');
      log.info('OPEN_REPORT: BrowserWindow opened', { tempPath });
      return { success: true };
    } catch (err) {
      log.error('OPEN_REPORT failed', { error: err.message });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(CH.IMPORT_FILE, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(_mainWindow, {
      title: 'Import Report File',
      properties: ['openFile'],
      filters: [
      { name: 'All Supported', extensions: ['json', 'csv', 'xlsx'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Excel', extensions: ['xlsx'] }]

    });

    if (canceled || filePaths.length === 0) {
      return { success: false, reason: 'cancelled' };
    }

    const filePath = filePaths[0];
    try {
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const data = await fs.promises.readFile(filePath);
      const content = ext === 'xlsx' ? data.toString('base64') : data.toString('utf8');
      return { success: true, content, ext, filename: path.basename(filePath) };
    } catch (err) {
      log.error('IMPORT_FILE read failed', { error: err.message, code: err.code });
      const reason = err.code === 'ENOENT' ? 'File not found — it may have been moved or deleted' :
      err.code === 'EACCES' ? 'Permission denied reading file' :
      err.message;
      return { success: false, error: reason };
    }
  });
}

function _registerBlobHandlers() {
  ipcMain.handle(CH.REGISTER_BLOB, (event, { blobId, base64, mimeType }) => {
    if (!_blobCache || !_blobCacheSet) {
      log.warn('REGISTER_BLOB: blob cache not initialised');
      return { success: false };
    }
    if (!blobId || !/^[^:]+:[^:]+$/.test(blobId)) {
      log.warn('REGISTER_BLOB: invalid blobId format rejected', { blobId });
      return { success: false, error: 'blobId must be comparisonId:keyframeId' };
    }
    _blobCacheSet(blobId, {
      buffer: Buffer.from(base64, 'base64'),
      mimeType: mimeType ?? 'image/webp'
    });
    log.debug('Blob registered in protocol cache', { blobId });
    return { success: true };
  });

  ipcMain.handle(CH.UNREGISTER_BLOBS_BY_COMPARISON, (event, comparisonId) => {
    if (!_blobCache || !_blobCacheDelete) {return { success: false };}
    let removed = 0;
    for (const key of Array.from(_blobCache.keys())) {
      if (key.startsWith(`${comparisonId}:`)) {
        _blobCacheDelete(key);
        removed++;
      }
    }
    log.debug('Blobs unregistered from protocol cache', { comparisonId, removed });
    return { success: true, removed };
  });
}

function _registerMetaHandlers() {
  ipcMain.handle(CH.GET_VERSION, () => app.getVersion());
  ipcMain.handle(CH.GET_PERF_METRICS, () => ({
    success: true, metrics: playwrightManager.getPerformanceSnapshot(), timestamp: Date.now()
  }));
}

function _registerBrowserHandlers() {
  ipcMain.handle(CH.GET_AVAILABLE_BROWSERS, async (event, opts = {}) => {



    let browserDetector;
    try {
      browserDetector = require('./browser-detector');
    } catch (err) {
      log.error('GET_AVAILABLE_BROWSERS: failed to load browser-detector', { error: err.message });
      return { success: false, error: err.message };
    }
    const refresh = Boolean(opts && opts.refresh);
    try {
      const { browsers, detectedAt } = await browserDetector.detectBrowsers({ refresh });
      return { success: true, browsers, detectedAt };
    } catch (err) {


      log.error('GET_AVAILABLE_BROWSERS failed', { error: err?.message ?? String(err) });
      return { success: false, error: err?.message ?? String(err) };
    }
  });
}

module.exports = { registerIpcHandlers, setBlobCache };