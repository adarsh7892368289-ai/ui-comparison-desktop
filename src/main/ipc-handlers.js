'use strict';

const { ipcMain, dialog, app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const log = require('electron-log');

const CH = require('./ipc-channels');
const playwrightManager = require('./playwright-manager');
const bulkRunner = require('./bulk-runner');
const sauceBinaryManager = require('./saucelabs-binary-manager');
const sauceManager = require('./saucelabs-manager');
const { config: defaultsConfig } = require('../config/defaults.js');

let _mainWindow = null;
let _blobCache = null;
let _blobCacheSet = null;
let _blobCacheDelete = null;

const _cancelRegistry = new Map();

const _bulkJobs = new Map();





const _approvedDirs = new Set();

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
  _registerBulkHandlers();
  _registerSauceHandlers();
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
    const { baselineId, compareId, mode, baselineUrl, compareUrl, baselineElements, compareElements, includeScreenshots, browser, operationId, comparisonId, tolerances } = params;
    log.info('START_COMPARISON', { baselineId, compareId, mode, baselineCount: baselineElements?.length, compareCount: compareElements?.length, browserType: browser?.browserType, tolerances });

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
        tolerances: tolerances ?? null,
        comparisonId: comparisonId ?? operationId,
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

  ipcMain.handle(CH.PICK_DIRECTORY, async (event, { title } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(_mainWindow, {
      title: title ?? 'Choose folder for bulk export',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths?.length) {
      return { success: false, reason: 'cancelled' };
    }
    const dirPath = filePaths[0];
    _approvedDirs.add(dirPath);
    return { success: true, dirPath };
  });

  ipcMain.handle(CH.EXPORT_FILE_TO_DIRECTORY, async (event, payload = {}) => {
    const { dirPath, filename, content, encoding } = payload;
    if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) {
      return { success: false, error: 'Invalid dirPath' };
    }
    if (!_approvedDirs.has(dirPath)) {
      log.warn('EXPORT_FILE_TO_DIRECTORY rejected: dirPath not approved this session', { dirPath });
      return { success: false, error: 'Directory not approved — pick a folder first' };
    }
    if (typeof filename !== 'string' || !filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return { success: false, error: 'Invalid filename' };
    }
    const filePath = path.join(dirPath, filename);
    try {
      let body;
      if (content instanceof Uint8Array) {
        body = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
      } else if (content instanceof ArrayBuffer) {
        body = Buffer.from(content);
      } else if (Array.isArray(content)) {
        body = Buffer.from(content);
      } else if (typeof content === 'string') {
        body = content;
      } else {
        return { success: false, error: 'Unsupported content type' };
      }
      const writeEncoding = typeof body === 'string' ? encoding ?? 'utf8' : undefined;
      await fs.promises.writeFile(filePath, body, writeEncoding);
      return { success: true, filePath };
    } catch (err) {
      log.error('EXPORT_FILE_TO_DIRECTORY write failed', { error: err.message, code: err.code, filePath });
      const reason = err.code === 'EACCES' ? 'Permission denied — choose a different folder' :
      err.code === 'EBUSY' ? 'File is in use by another process' :
      err.code === 'ENOENT' ? 'Folder no longer exists' :
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

function _registerBulkHandlers() {
  ipcMain.handle(CH.BULK_START_JOB, (event, payload = {}) => {
    try {
      const {
        jobId,
        filename,
        pairs,
        concurrency,
        hostCooldownMs,
        comparisonIdsByPairIndex,
        tolerances
      } = payload;

      if (!jobId || !Array.isArray(pairs) || pairs.length === 0) {
        return { success: false, error: 'Invalid bulk job payload' };
      }

      const maxConcurrency = defaultsConfig?.bulk?.maxConcurrency ?? 4;
      const safeConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, maxConcurrency));
      const cooldown = Math.max(0, Number(hostCooldownMs) || 0);

      const opIds = new Set();
      const entry = {
        opIds,
        startedAt: Date.now(),
        pLimitInstance: null,
        filename: filename ?? null
      };
      _bulkJobs.set(jobId, entry);

      const isMasterCancelled = () => !_bulkJobs.has(jobId);
      const pushEvent = (channel, evtPayload) => _pushToWindow(channel, evtPayload);

      entry.providedElements = new Map();
      entry.providedWaiters = new Map();

      const ctx = {
        cancelRegistry: _cancelRegistry,
        blobCache: _blobCache,
        registerOp: (opId, kind) => _registerOp(opId, kind),
        unregisterOp: (opId) => {
          opIds.delete(opId);
          _unregisterOp(opId);
        },
        addJobOpId: (jId, opId) => {
          const e = _bulkJobs.get(jId);
          if (e) {e.opIds.add(opId);}
        },
        setLimitInstance: (instance) => {
          const e = _bulkJobs.get(jobId);
          if (e) {e.pLimitInstance = instance;}
        },
        setPairSettlers: (settlers) => {
          const e = _bulkJobs.get(jobId);
          if (e) {e.pairSettlers = settlers;}
        },
        cleanupJob: (jId) => {
          const e = _bulkJobs.get(jId);
          if (e?.providedWaiters) {
            for (const w of e.providedWaiters.values()) {
              try {w.reject(new Error('Bulk job cleaned up'));} catch {void 0;}
            }
            e.providedWaiters.clear();
          }
          _bulkJobs.delete(jId);
        },
        awaitProvidedElements: (pairIndex, side, timeoutMs = 10_000) => {
          const e = _bulkJobs.get(jobId);
          if (!e) {return Promise.reject(new Error('Bulk job not registered'));}
          const key = `${pairIndex}:${side}`;
          if (e.providedElements.has(key)) {
            return Promise.resolve(e.providedElements.get(key));
          }
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              e.providedWaiters.delete(key);
              reject(Object.assign(new Error('Timed out waiting for provided elements'), {
                code: 'STORAGE_DEGRADED'
              }));
            }, timeoutMs);
            e.providedWaiters.set(key, {
              resolve: (val) => {clearTimeout(timer);resolve(val);},
              reject: (err) => {clearTimeout(timer);reject(err);}
            });
          });
        }
      };

      const jobSpec = {
        jobId,
        filename: filename ?? null,
        pairs,
        concurrency: safeConcurrency,
        hostCooldownMs: cooldown,
        comparisonIdsByPairIndex: comparisonIdsByPairIndex ?? {},
        tolerances: tolerances ?? null
      };

      bulkRunner.runBulkJob(jobSpec, pushEvent, isMasterCancelled, ctx).catch((err) => {
        log.error('[BulkHandler] runBulkJob fatal', { jobId, err: err?.message });
        _pushToWindow(CH.BULK_JOB_COMPLETE, {
          jobId,
          summary: { total: pairs.length, succeeded: 0, failed: pairs.length, cancelled: 0, deduped: 0 },
          durationMs: Date.now() - entry.startedAt,
          error: err?.message || String(err)
        });
        _bulkJobs.delete(jobId);
      });

      log.info('[BulkHandler] BULK_START_JOB dispatched', { jobId, pairCount: pairs.length, concurrency: safeConcurrency });
      return { success: true, jobId };
    } catch (err) {
      log.error('[BulkHandler] BULK_START_JOB failed', { error: err?.message });
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle(CH.CANCEL_BULK_JOB, (event, { jobId } = {}) => {
    const entry = _bulkJobs.get(jobId);
    if (!entry) {return { acknowledged: true };}

    try {
      if (entry.pLimitInstance && typeof entry.pLimitInstance.clearQueue === 'function') {
        entry.pLimitInstance.clearQueue();
      }
    } catch (err) {
      log.warn('[BulkHandler] clearQueue failed', { jobId, err: err?.message });
    }

    for (const opId of entry.opIds) {
      const ent = _cancelRegistry.get(opId);
      if (ent) {ent.cancelled = true;}
    }

    let synthesised = 0;
    if (entry.pairSettlers && typeof entry.pairSettlers.entries === 'function') {
      for (const [pairIndex, settler] of entry.pairSettlers) {
        if (!settler.started && !settler.settled) {
          _pushToWindow(CH.BULK_PAIR_COMPLETED, { jobId, pairIndex, status: 'cancelled' });
          try {settler.settle({ pairIndex, status: 'cancelled' });} catch {void 0;}
          synthesised++;
        }
      }
    }

    if (entry.providedWaiters) {
      for (const w of entry.providedWaiters.values()) {
        try {w.reject(Object.assign(new Error('Bulk job cancelled'), { code: 'CANCELLED' }));} catch {void 0;}
      }
      entry.providedWaiters.clear();
    }

    _bulkJobs.delete(jobId);
    log.info('[BulkHandler] CANCEL_BULK_JOB processed', { jobId, droppedPending: synthesised });
    return { acknowledged: true };
  });

  ipcMain.handle(CH.GET_HOST_MEMORY, () => ({
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024)
  }));

  ipcMain.handle(CH.BULK_PROVIDE_ELEMENTS, (event, payload = {}) => {
    const { jobId, pairIndex, side, elements } = payload;
    if (!jobId || typeof pairIndex !== 'number' || side !== 'baseline' && side !== 'compare') {
      return { accepted: false, error: 'Invalid BULK_PROVIDE_ELEMENTS payload' };
    }
    const entry = _bulkJobs.get(jobId);
    if (!entry) {
      return { accepted: false, error: `Bulk job not found: ${jobId}` };
    }
    const key = `${pairIndex}:${side}`;
    const list = Array.isArray(elements) ? elements : [];
    entry.providedElements.set(key, list);
    const waiter = entry.providedWaiters.get(key);
    if (waiter) {
      entry.providedWaiters.delete(key);
      try {waiter.resolve(list);} catch {void 0;}
    }
    return { accepted: true };
  });
}

function _registerSauceHandlers() {
  try {
    sauceManager.cleanupOrphanedTmpDirs();
  } catch (err) {
    log.warn('[SauceHandler] cleanupOrphanedTmpDirs failed', { error: err?.message });
  }

  ipcMain.handle(CH.SAUCE_VALIDATE_CREDENTIALS, async (event, payload = {}) => {
    const { username, accessKey, region } = payload;
    const timeoutMs = defaultsConfig?.saucelabs?.versionCheckTimeoutMs ?? 5000;
    const compatibleRange = defaultsConfig?.saucelabs?.compatibleSaucectlRange ?? '>=0.200.0 <1.0.0';

    const binPath = await sauceBinaryManager.resolveBinaryPath({ timeoutMs });
    if (!binPath) {
      return {
        success: false,
        error: 'saucectl not found. Install it via: npm install -g saucectl, or place it on your PATH.'
      };
    }

    sauceBinaryManager.runUpdateCheck(compatibleRange, {
      hasActiveJobs: () => false
    }).catch((err) => {
      log.warn('[SauceHandler] background update check failed', { error: err?.message });
    });

    const result = await sauceManager.validateCredentials({ username, accessKey, region });
    return result;
  });

  ipcMain.handle(CH.SAUCE_SUBMIT_JOB, (event, payload = {}) => {
    const {
      username, accessKey, region,
      url, platform, browserName, screenResolution,
      tunnelName, tunnelOwner, filters, device,
      playwrightVersion, buildName, tags, visibility, timeout
    } = payload;

    if (!username || !accessKey || !url) {
      return { success: false, error: 'Missing required parameters' };
    }

    const jobId = crypto.randomUUID();

    sauceManager.submitExtraction({
      jobId,
      username,
      accessKey,
      region: region || 'us-west-1',
      url,
      platform: platform || 'Windows 11',
      browserName: browserName || 'chromium',
      screenResolution: screenResolution || '1920x1080',
      tunnelName: tunnelName || null,
      tunnelOwner: tunnelOwner || null,
      filters: filters || null,
      device: device || null,
      playwrightVersion: playwrightVersion || defaultsConfig.saucelabs.defaultPlaywrightVersion,
      concurrency: 1,
      buildName: buildName || null,
      tags: tags || defaultsConfig.saucelabs.defaultTags,
      visibility: visibility || defaultsConfig.saucelabs.defaultVisibility,
      timeout: timeout || defaultsConfig.saucelabs.defaultTimeout,
      onProgress: (progress) => {
        _pushToWindow(CH.SAUCE_JOB_PROGRESS, { jobId, ...progress });
      }
    }).then((result) => {
      _pushToWindow(CH.SAUCE_JOB_COMPLETE, {
        jobId,
        success: true,
        report: result.report,
        manifest: result.manifest,
        sessionId: result.sessionId,
        artifactsDir: result.artifactsDir
      });
    }).catch((err) => {
      if (err?._sauceJobCancelled) {
        log.info('[SauceHandler] extraction cancelled', { jobId });
        _pushToWindow(CH.SAUCE_JOB_COMPLETE, { jobId, success: false, cancelled: true, error: 'Cancelled' });
        return;
      }
      log.error('[SauceHandler] extraction failed', { jobId, error: err?.message });
      _pushToWindow(CH.SAUCE_JOB_COMPLETE, {
        jobId,
        success: false,
        error: err?.message || 'Extraction failed'
      });
    });

    return { success: true, jobId };
  });

  ipcMain.handle(CH.SAUCE_SUBMIT_COMPARISON, (event, payload = {}) => {
    const {
      username, accessKey, region,
      baselineUrl, compareUrl,
      platform, browserName, screenResolution,
      tunnelName, tunnelOwner, filters, device,
      playwrightVersion, concurrency, buildName, tags, visibility, timeout
    } = payload;

    if (!username || !accessKey || !baselineUrl || !compareUrl) {
      return { success: false, error: 'Missing required parameters' };
    }

    const jobId = crypto.randomUUID();

    sauceManager.submitComparison({
      jobId,
      username,
      accessKey,
      region: region || 'us-west-1',
      baselineUrl,
      compareUrl,
      platform: platform || 'Windows 11',
      browserName: browserName || 'chromium',
      screenResolution: screenResolution || '1920x1080',
      tunnelName: tunnelName || null,
      tunnelOwner: tunnelOwner || null,
      filters: filters || null,
      device: device || null,
      playwrightVersion: playwrightVersion || defaultsConfig.saucelabs.defaultPlaywrightVersion,
      concurrency: concurrency || defaultsConfig.saucelabs.defaultConcurrency,
      buildName: buildName || null,
      tags: tags || defaultsConfig.saucelabs.defaultTags,
      visibility: visibility || defaultsConfig.saucelabs.defaultVisibility,
      timeout: timeout || defaultsConfig.saucelabs.defaultTimeout,
      onProgress: (progress) => {
        _pushToWindow(CH.SAUCE_JOB_PROGRESS, { jobId, ...progress });
      },
      onSessionId: (ids) => {
        _pushToWindow(CH.SAUCE_JOB_PROGRESS, {
          jobId,
          phase: 'running',
          baselineSessionId: ids.baselineSessionId,
          compareSessionId: ids.compareSessionId
        });
      }
    }).then((result) => {
      _pushToWindow(CH.SAUCE_JOB_COMPLETE, {
        jobId,
        success: true,
        baselineReport: result.baselineReport,
        compareReport: result.compareReport,
        baselineManifest: result.baselineManifest,
        compareManifest: result.compareManifest,
        baselineSessionId: result.baselineSessionId,
        compareSessionId: result.compareSessionId,
        baselineArtifactDir: result.baselineArtifactDir,
        compareArtifactDir: result.compareArtifactDir
      });
    }).catch((err) => {
      if (err?._sauceJobCancelled) {
        log.info('[SauceHandler] comparison cancelled', { jobId });
        _pushToWindow(CH.SAUCE_JOB_COMPLETE, { jobId, success: false, cancelled: true, error: 'Cancelled' });
        return;
      }
      log.error('[SauceHandler] comparison failed', { jobId, error: err?.message });
      const payload = {
        jobId,
        success: false,
        error: err?.message || 'Comparison failed'
      };
      if (err.partiallyFailed) {
        payload.partiallyFailed = true;
        payload.partiallyFailedSession = err.partiallyFailedSession;
        payload.baselineSessionId = err.baselineSessionId;
        payload.compareSessionId = err.compareSessionId;
        payload.baselineStatus = err.baselineStatus;
        payload.compareStatus = err.compareStatus;
      }
      _pushToWindow(CH.SAUCE_JOB_COMPLETE, payload);
    });

    return { success: true, jobId };
  });

  ipcMain.handle(CH.SAUCE_CANCEL_JOB, async (event, payload = {}) => {
    const { jobId, username, accessKey, region, baselineSessionId, compareSessionId } = payload;
    log.info('[SauceHandler] SAUCE_CANCEL_JOB received', { jobId });



    if (jobId && typeof sauceManager.cancelJob === 'function') {
      try {
        await sauceManager.cancelJob(jobId, {
          username,
          accessKey,
          region: region || 'us-west-1'
        });
      } catch (err) {
        log.warn('[SauceHandler] cancelJob failed', { jobId, error: err?.message });
      }
    }



    if (username && accessKey) {
      const sessionIds = [baselineSessionId, compareSessionId].filter(Boolean);
      if (sessionIds.length > 0) {
        try {
          await sauceManager._cancelRemoteSessions({
            username, accessKey,
            region: region || 'us-west-1',
            sessionIds
          });
        } catch (err) {
          log.warn('[SauceHandler] remote session termination failed', { error: err?.message });
        }
      }
    }

    return { acknowledged: true };
  });

  ipcMain.handle(CH.SAUCE_READ_KEYFRAME, async (event, payload = {}) => {
    const { artifactDir, filename } = payload;
    if (typeof artifactDir !== 'string' || !path.isAbsolute(artifactDir)) {
      return { success: false, error: 'Invalid artifactDir' };
    }



    if (typeof filename !== 'string' || !/^keyframe-\d+\.jpg$/.test(filename)) {
      return { success: false, error: 'Invalid filename' };
    }

    const artifactsRoot = path.join(app.getPath('userData'), 'saucelabs-artifacts');
    const resolvedDir = path.resolve(artifactDir);
    const resolvedRoot = path.resolve(artifactsRoot);
    if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) {
      log.warn('SAUCE_READ_KEYFRAME rejected: path outside saucelabs-artifacts', { artifactDir });
      return { success: false, error: 'Path not under saucelabs-artifacts' };
    }
    const filePath = path.join(resolvedDir, filename);
    try {
      const buffer = await fs.promises.readFile(filePath);
      return { success: true, base64: buffer.toString('base64'), mimeType: 'image/jpeg' };
    } catch (err) {
      log.warn('SAUCE_READ_KEYFRAME read failed', { filePath, error: err.message, code: err.code });
      return { success: false, error: err.code === 'ENOENT' ? 'Keyframe file not found' : err.message };
    }
  });

  ipcMain.handle(CH.SAUCE_RETRY_FAILED_SESSION, (event, payload = {}) => {
    const {
      username, accessKey, region,
      jobId, failedSide, failedSideUrl, successSideSessionId,
      platform, browserName, screenResolution, tunnelName, tunnelOwner, filters, device,
      playwrightVersion, concurrency, buildName, tags, visibility, timeout
    } = payload;

    if (!username || !accessKey || !jobId || !failedSide || !failedSideUrl || !successSideSessionId) {
      return { success: false, error: 'Missing required parameters for retry' };
    }

    sauceManager.retryFailedSession({
      username,
      accessKey,
      region: region || 'us-west-1',
      failedSide,
      failedSideUrl,
      successSideSessionId,
      platform: platform || 'Windows 11',
      browserName: browserName || 'chromium',
      screenResolution: screenResolution || '1920x1080',
      tunnelName: tunnelName || null,
      tunnelOwner: tunnelOwner || null,
      filters: filters || null,
      device: device || null,
      jobId,
      playwrightVersion: playwrightVersion || defaultsConfig.saucelabs.defaultPlaywrightVersion,
      concurrency: concurrency || defaultsConfig.saucelabs.defaultConcurrency,
      buildName: buildName || null,
      tags: tags || defaultsConfig.saucelabs.defaultTags,
      visibility: visibility || defaultsConfig.saucelabs.defaultVisibility,
      timeout: timeout || defaultsConfig.saucelabs.defaultTimeout,
      onProgress: (progress) => {
        _pushToWindow(CH.SAUCE_JOB_PROGRESS, { jobId, ...progress });
      }
    }).then((result) => {
      _pushToWindow(CH.SAUCE_JOB_COMPLETE, {
        jobId,
        success: true,
        baselineReport: result.baselineReport,
        compareReport: result.compareReport,
        baselineManifest: result.baselineManifest,
        compareManifest: result.compareManifest,
        baselineSessionId: result.baselineSessionId,
        compareSessionId: result.compareSessionId,
        baselineArtifactDir: result.baselineArtifactDir,
        compareArtifactDir: result.compareArtifactDir
      });
    }).catch((err) => {
      log.error('[SauceHandler] retry failed', { jobId, error: err?.message });
      const errPayload = {
        jobId,
        success: false,
        error: err?.message || 'Retry failed'
      };
      if (err.partiallyFailed) {
        errPayload.partiallyFailed = true;
        errPayload.partiallyFailedSession = err.partiallyFailedSession;
      }
      _pushToWindow(CH.SAUCE_JOB_COMPLETE, errPayload);
    });

    return { success: true, jobId };
  });
}

module.exports = { registerIpcHandlers, setBlobCache };