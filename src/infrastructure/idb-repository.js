import { get } from '../config/defaults.js';
import { ERROR_CODES, errorTracker } from './error-tracker.js';
import logger from './logger.js';

const DB_NAME                    = 'ui_comparison_db';
const DB_VERSION                 = 6;
const STORE_REPORTS              = 'reports';
const STORE_ELEMENTS             = 'elements';
const STORE_COMPARISONS          = 'comparisons';
const STORE_COMP_DIFFS           = 'comparison_diffs';
const STORE_COMP_SUMMARY         = 'comparison_summary';
const STORE_VISUAL_BLOBS         = 'visual_blobs';
const STORE_VISUAL_KEYFRAMES     = 'visual_keyframes';
const STORE_VISUAL_ELEMENT_RECTS = 'visual_element_rects';
const STORE_OP_LOG               = 'operation_log';
const MAX_COMPARISONS            = 20;
const OP_STATUS_PENDING          = 'PENDING';
const OP_STATUS_COMPLETE         = 'COMPLETE';
const CIRCUIT_BREAKER_LIMIT      = 3;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

function transactionToPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

function buildPairKey(baselineId, compareId, mode) {
  return `${baselineId}_${compareId}_${mode}`;
}

function trackError(code, message, context = {}) {
  errorTracker.track({ code, message, context });
}

function collectCursor(source, direction = 'next') {
  return new Promise((resolve, reject) => {
    const records = [];
    const req = source.openCursor(null, direction);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        records.push(cursor.value);
        cursor.continue();
      } else {
        resolve(records);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

function commitReportWrite(reportStore, elementStore, reportCtx) {
  reportStore.put(reportCtx.meta);
  if (reportCtx.elements?.length) {
    elementStore.put({ reportId: reportCtx.id, data: reportCtx.elements });
  }
}

function buildReportStores(db) {
  const reportStore = db.createObjectStore(STORE_REPORTS, { keyPath: 'id' });
  reportStore.createIndex('by_timestamp', 'timestamp',          { unique: false });
  reportStore.createIndex('by_url',       'url',                { unique: false });
  reportStore.createIndex('by_url_ts',    ['url', 'timestamp'], { unique: false });
  db.createObjectStore(STORE_ELEMENTS, { keyPath: 'reportId' });
}

function buildComparisonStores(db) {
  const compStore = db.createObjectStore(STORE_COMPARISONS, { keyPath: 'id' });
  compStore.createIndex('by_pair',      'pairKey',    { unique: true  });
  compStore.createIndex('by_timestamp', 'timestamp',  { unique: false });
  compStore.createIndex('by_baseline',  'baselineId', { unique: false });
  compStore.createIndex('by_compare',   'compareId',  { unique: false });
  db.createObjectStore(STORE_COMP_DIFFS, { keyPath: 'comparisonId' });
}

function buildAuxStores(db) {
  const summaryStore = db.createObjectStore(STORE_COMP_SUMMARY, { keyPath: 'comparisonId' });
  summaryStore.createIndex('by_timestamp', 'timestamp', { unique: false });

  const blobStore = db.createObjectStore(STORE_VISUAL_BLOBS, { keyPath: 'key' });
  blobStore.createIndex('by_comparisonId', 'comparisonId', { unique: false });
  blobStore.createIndex('by_timestamp',    'timestamp',    { unique: false });

  const logStore = db.createObjectStore(STORE_OP_LOG, { keyPath: 'id' });
  logStore.createIndex('by_status',    'status',    { unique: false });
  logStore.createIndex('by_timestamp', 'timestamp', { unique: false });
}

function upgradeToV5(upgradeTx) {
  upgradeTx.objectStore(STORE_COMPARISONS)
    .createIndex('by_triple', ['baselineId', 'compareId', 'mode'], { unique: true });

  const stalePurge = [STORE_REPORTS, STORE_ELEMENTS, STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY];
  for (const storeName of stalePurge) {
    upgradeTx.objectStore(storeName).clear();
  }
}

function upgradeToV6(db) {
  const kfStore = db.createObjectStore(STORE_VISUAL_KEYFRAMES, { keyPath: 'id' });
  kfStore.createIndex('by_session', 'sessionId', { unique: false });

  const rectStore = db.createObjectStore(STORE_VISUAL_ELEMENT_RECTS, { keyPath: 'id' });
  rectStore.createIndex('by_session',         'sessionId',                 { unique: false });
  rectStore.createIndex('by_session_element', ['sessionId', 'elementKey'], { unique: false });
}

function runUpgrade(db, upgradeTx, oldVersion) {
  if (oldVersion < 1) {buildReportStores(db);}
  if (oldVersion < 2) {buildComparisonStores(db);}
  if (oldVersion < 4) {buildAuxStores(db);}
  if (oldVersion < 5) {upgradeToV5(upgradeTx);}
  if (oldVersion < 6) {upgradeToV6(db);}
}

class IDBRepository {
  #db                  = null;
  #opening             = null;
  #writeQueue          = Promise.resolve();
  #consecutiveFailures = 0;
  #circuitOpen         = false;

  #handleWriteFailure(err) {
    this.#consecutiveFailures += 1;
    logger.error('IDB write failure recorded', {
      error:               err.message,
      consecutiveFailures: this.#consecutiveFailures,
      limit:               CIRCUIT_BREAKER_LIMIT
    });
    trackError(ERROR_CODES.STORAGE_WRITE_FAILED, err.message);
    if (this.#consecutiveFailures >= CIRCUIT_BREAKER_LIMIT) {
      this.#circuitOpen = true;
      logger.error('IDB circuit breaker opened — write queue halted', {
        limit: CIRCUIT_BREAKER_LIMIT
      });
    }
  }

  #enqueue(fn) {
    if (this.#circuitOpen) {
      return Promise.reject(new Error(
        `IDB write queue halted after ${CIRCUIT_BREAKER_LIMIT} consecutive failures`
      ));
    }

    const taskPromise = this.#writeQueue.then(async () => {
      try {
        const taskResult = await fn();
        if (taskResult?.success === false) {
          this.#handleWriteFailure(new Error(taskResult.error ?? 'Write failed'));
        } else {
          this.#consecutiveFailures = 0;
        }
        return taskResult;
      } catch (taskError) {
        this.#handleWriteFailure(taskError);
        throw taskError;
      }
    });

    this.#writeQueue = taskPromise.then(
      () => undefined,
      () => undefined
    );

    return taskPromise;
  }

  #getDB() {
    if (this.#db) {
      return Promise.resolve(this.#db);
    }
    if (this.#opening) {
      return this.#opening;
    }

    this.#opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        runUpgrade(event.target.result, event.target.transaction, event.oldVersion);
      };

      request.onsuccess = (event) => {
        const openedDb = event.target.result;

        openedDb.onversionchange = () => {
          openedDb.close();
          this.#db = null;
        };

        openedDb.onerror = (dbEvent) => {
          trackError(ERROR_CODES.STORAGE_READ_FAILED, dbEvent.target.error?.message ?? 'IDB error');
        };

        this.#db      = openedDb;
        this.#opening = null;
        resolve(openedDb);
      };

      request.onerror = (event) => {
        this.#opening = null;
        reject(new Error(`IDB open failed: ${event.target.error?.message}`));
      };

      request.onblocked = () => {
        this.#opening = null;
        reject(new Error('IDB open blocked — close other extension tabs and retry'));
      };
    });

    return this.#opening;
  }

  saveReport(report) {
    return this.#enqueue(() => this.#saveReportInner(report));
  }

  async #saveReportInner(report) {
    const maxReports     = get('storage.maxReports');
    const { elements, ...meta } = report;

    try {
      const db = await this.#getDB();
      await this.#writeReportWithEviction(db, meta, elements, meta.id, maxReports);
      return { success: true, id: meta.id };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message, { id: meta.id });
      return { success: false, error: writeError.message };
    }
  }

  #writeReportWithEviction(db, meta, elements, reportId, maxReports) {
    return new Promise((resolve, reject) => {
      const tx           = db.transaction([STORE_REPORTS, STORE_ELEMENTS], 'readwrite');
      const reportStore  = tx.objectStore(STORE_REPORTS);
      const elementStore = tx.objectStore(STORE_ELEMENTS);

      transactionToPromise(tx).then(resolve).catch(reject);

      const countReq = reportStore.count();
      countReq.onerror  = () => tx.abort();
      countReq.onsuccess = () => {
        const excess    = countReq.result - maxReports + 1;
        const reportCtx = { meta, elements, id: reportId };
        if (excess <= 0) {
          commitReportWrite(reportStore, elementStore, reportCtx);
          return;
        }
        this.#evictReports(reportStore, elementStore, reportCtx, excess);
      };
    });
  }

  #evictReports(reportStore, elementStore, reportCtx, excess) {
    const cursorReq = reportStore.index('by_timestamp').openCursor(null, 'next');
    let deleted = 0;

    cursorReq.onerror  = () => reportStore.transaction.abort();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && deleted < excess) {
        reportStore.delete(cursor.primaryKey);
        elementStore.delete(cursor.primaryKey);
        deleted += 1;
        cursor.continue();
      } else {
        commitReportWrite(reportStore, elementStore, reportCtx);
      }
    };
  }

  async loadReports() {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_REPORTS, 'readonly');
      return collectCursor(tx.objectStore(STORE_REPORTS).index('by_timestamp'), 'prev');
    } catch (readError) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
      return [];
    }
  }

  async loadReportElements(reportId) {
    try {
      const db     = await this.#getDB();
      const tx     = db.transaction(STORE_ELEMENTS, 'readonly');
      const record = await requestToPromise(tx.objectStore(STORE_ELEMENTS).get(reportId));
      return record?.data ?? [];
    } catch (readError) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message, { reportId });
      return [];
    }
  }

  deleteReport(id) {
    return this.#enqueue(() => this.#deleteReportInner(id));
  }

  async #deleteReportInner(id) {
    try {
      const db              = await this.#getDB();
      const compIdsToDelete = await this.#getComparisonIdsByReportId(db, id);

      const stores = [STORE_REPORTS, STORE_ELEMENTS, STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY];
      const tx     = db.transaction(stores, 'readwrite');

      tx.objectStore(STORE_REPORTS).delete(id);
      tx.objectStore(STORE_ELEMENTS).delete(id);

      for (const compId of compIdsToDelete) {
        tx.objectStore(STORE_COMPARISONS).delete(compId);
        tx.objectStore(STORE_COMP_DIFFS).delete(compId);
        tx.objectStore(STORE_COMP_SUMMARY).delete(compId);
      }

      await transactionToPromise(tx);
      return { success: true };
    } catch (deleteError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, deleteError.message, { id });
      return { success: false, error: deleteError.message };
    }
  }

  async #getComparisonIdsByReportId(db, reportId) {
    try {
      const tx     = db.transaction(STORE_COMPARISONS, 'readonly');
      const store  = tx.objectStore(STORE_COMPARISONS);
      const range  = IDBKeyRange.only(reportId);
      const [baselineKeys, compareKeys] = await Promise.all([
        requestToPromise(store.index('by_baseline').getAllKeys(range)),
        requestToPromise(store.index('by_compare').getAllKeys(range))
      ]);
      return [...new Set([...(baselineKeys ?? []), ...(compareKeys ?? [])])];
    } catch {
      return [];
    }
  }

  deleteAllReports() {
    return this.#enqueue(() => this.#deleteAllInner());
  }

  async #deleteAllInner() {
    try {
      const db     = await this.#getDB();
      const stores = [
        STORE_REPORTS, STORE_ELEMENTS,
        STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY,
        STORE_VISUAL_BLOBS, STORE_VISUAL_KEYFRAMES, STORE_VISUAL_ELEMENT_RECTS
      ];
      const tx = db.transaction(stores, 'readwrite');
      for (const storeName of stores) {
        tx.objectStore(storeName).clear();
      }
      await transactionToPromise(tx);
      return { success: true };
    } catch (clearError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, clearError.message);
      return { success: false, error: clearError.message };
    }
  }

  saveComparison(meta, slimResults) {
    return this.#enqueue(() => this.#saveComparisonInner(meta, slimResults));
  }

  async #saveComparisonInner(meta, slimResults) {
    const logId = crypto.randomUUID();
    try {
      const db = await this.#getDB();
      await this.#writeWalEntry(db, logId, 'SAVE_COMPARISON', { comparisonId: meta.id });
      await this.#writeComparisonWithEviction(db, meta, slimResults);
      await this.#completeWalEntry(db, logId);
      return { success: true, id: meta.id };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message);
      return { success: false, error: writeError.message };
    }
  }

  #writeComparisonWithEviction(db, meta, slimResults) {
    return new Promise((resolve, reject) => {
      const storeNames = [STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY];
      const tx         = db.transaction(storeNames, 'readwrite');
      const writeCtx   = {
        comp:    tx.objectStore(STORE_COMPARISONS),
        diffs:   tx.objectStore(STORE_COMP_DIFFS),
        summary: tx.objectStore(STORE_COMP_SUMMARY)
      };

      transactionToPromise(tx).then(resolve).catch(reject);

      const pairReq = writeCtx.comp.index('by_pair').get(meta.pairKey);
      pairReq.onerror  = () => tx.abort();
      pairReq.onsuccess = () => {
        const existing = pairReq.result;
        if (existing) {
          writeCtx.comp.delete(existing.id);
          writeCtx.diffs.delete(existing.id);
          writeCtx.summary.delete(existing.id);
        }
        this.#evictAndWrite(writeCtx, meta, slimResults);
      };
    });
  }

  #evictAndWrite(writeCtx, meta, slimResults) {
    const writeAll = () => {
      writeCtx.comp.put(meta);
      writeCtx.diffs.put({ comparisonId: meta.id, results: slimResults });
      writeCtx.summary.put({ comparisonId: meta.id, timestamp: meta.timestamp, pairKey: meta.pairKey });
    };

    const tx = writeCtx.comp.transaction;
    const countReq = writeCtx.comp.count();
    countReq.onerror  = () => tx.abort();
    countReq.onsuccess = () => {
      const excess = countReq.result - MAX_COMPARISONS + 1;
      if (excess <= 0) {
        writeAll();
        return;
      }
      const cursorReq = writeCtx.comp.index('by_timestamp').openCursor(null, 'next');
      let deleted = 0;
      cursorReq.onerror  = () => tx.abort();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && deleted < excess) {
          const oldId = cursor.primaryKey;
          writeCtx.comp.delete(oldId);
          writeCtx.diffs.delete(oldId);
          writeCtx.summary.delete(oldId);
          deleted += 1;
          cursor.continue();
        } else {
          writeAll();
        }
      };
    };
  }

  async #writeWalEntry(db, id, operation, payload) {
    const tx = db.transaction(STORE_OP_LOG, 'readwrite');
    tx.objectStore(STORE_OP_LOG).put({
      id,
      operation,
      payload,
      status:    OP_STATUS_PENDING,
      timestamp: new Date().toISOString()
    });
    await transactionToPromise(tx);
  }

  async #completeWalEntry(db, id) {
    const tx    = db.transaction(STORE_OP_LOG, 'readwrite');
    const store = tx.objectStore(STORE_OP_LOG);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      if (getReq.result) {
        store.put({ ...getReq.result, status: OP_STATUS_COMPLETE });
      }
    };
    await transactionToPromise(tx);
  }

  async applyPendingOperations() {
    try {
      const db      = await this.#getDB();
      const tx      = db.transaction(STORE_OP_LOG, 'readonly');
      const pending = await requestToPromise(
        tx.objectStore(STORE_OP_LOG).index('by_status').getAll(IDBKeyRange.only(OP_STATUS_PENDING))
      );
      if (pending?.length) {
        errorTracker.track({
          code:    ERROR_CODES.STORAGE_VERSION_CONFLICT,
          message: `WAL replay: ${pending.length} pending operations found on startup`
        });
      }
    } catch (walError) {
      logger.warn('WAL replay check failed', { error: walError.message });
    }
  }

  async loadComparisonByPair(baselineId, compareId, mode) {
    try {
      const db      = await this.#getDB();
      const pairKey = buildPairKey(baselineId, compareId, mode);
      const tx      = db.transaction(STORE_COMPARISONS, 'readonly');
      const record  = await requestToPromise(
        tx.objectStore(STORE_COMPARISONS).index('by_pair').get(pairKey)
      );
      return record ?? null;
    } catch (readError) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
      return null;
    }
  }

  async loadComparisonDiffs(comparisonId) {
    try {
      const db     = await this.#getDB();
      const tx     = db.transaction(STORE_COMP_DIFFS, 'readonly');
      const record = await requestToPromise(tx.objectStore(STORE_COMP_DIFFS).get(comparisonId));
      return record?.results ?? [];
    } catch (readError) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
      return [];
    }
  }

  saveVisualBlob(key, blob, comparisonId) {
    return this.#enqueue(() => this.#saveVisualBlobInner(key, blob, comparisonId));
  }

  async #saveVisualBlobInner(key, blob, comparisonId) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_VISUAL_BLOBS, 'readwrite');
      tx.objectStore(STORE_VISUAL_BLOBS).put({ key, blob, comparisonId, timestamp: new Date().toISOString() });
      await transactionToPromise(tx);
      return { success: true };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message);
      return { success: false, error: writeError.message };
    }
  }

  async loadVisualBlob(key) {
    try {
      const db     = await this.#getDB();
      const tx     = db.transaction(STORE_VISUAL_BLOBS, 'readonly');
      const record = await requestToPromise(tx.objectStore(STORE_VISUAL_BLOBS).get(key));
      return record?.blob ?? null;
    } catch (readError) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
      return null;
    }
  }

  deleteVisualBlobsByComparisonId(comparisonId) {
    return this.#enqueue(() => this.#deleteVisualBlobsInner(comparisonId));
  }

  async #deleteVisualBlobsInner(comparisonId) {
    try {
      const db       = await this.#getDB();
      const readTx   = db.transaction(STORE_VISUAL_BLOBS, 'readonly');
      const blobKeys = await requestToPromise(
        readTx.objectStore(STORE_VISUAL_BLOBS).index('by_comparisonId').getAllKeys(IDBKeyRange.only(comparisonId))
      );
      if (!blobKeys?.length) {
        return { success: true };
      }
      const writeTx   = db.transaction(STORE_VISUAL_BLOBS, 'readwrite');
      const blobStore = writeTx.objectStore(STORE_VISUAL_BLOBS);
      for (const blobKey of blobKeys) {
        blobStore.delete(blobKey);
      }
      await transactionToPromise(writeTx);
      return { success: true };
    } catch (deleteError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, deleteError.message);
      return { success: false, error: deleteError.message };
    }
  }

  saveVisualKeyframe(keyframe) {
    return this.#enqueue(() => this.#saveVisualKeyframeInner(keyframe));
  }

  async #saveVisualKeyframeInner(keyframe) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_VISUAL_KEYFRAMES, 'readwrite');
      tx.objectStore(STORE_VISUAL_KEYFRAMES).put(keyframe);
      await transactionToPromise(tx);
      return { success: true };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message);
      return { success: false, error: writeError.message };
    }
  }

  async loadKeyframesBySession(sessionId) {
    try {
      const db      = await this.#getDB();
      const tx      = db.transaction(STORE_VISUAL_KEYFRAMES, 'readonly');
      const records = await requestToPromise(
        tx.objectStore(STORE_VISUAL_KEYFRAMES).index('by_session').getAll(IDBKeyRange.only(sessionId))
      );
      return new Map((records ?? []).map(r => [r.id, r]));
    } catch (readError) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
      return new Map();
    }
  }

  saveVisualElementRect(rectRecord) {
    return this.#enqueue(() => this.#saveVisualElementRectInner(rectRecord));
  }

  async #saveVisualElementRectInner(rectRecord) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_VISUAL_ELEMENT_RECTS, 'readwrite');
      tx.objectStore(STORE_VISUAL_ELEMENT_RECTS).put(rectRecord);
      await transactionToPromise(tx);
      return { success: true };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message);
      return { success: false, error: writeError.message };
    }
  }

  saveVisualElementRects(rectRecords) {
    return this.#enqueue(() => this.#saveVisualElementRectsInner(rectRecords));
  }

  async #saveVisualElementRectsInner(rectRecords) {
    if (!rectRecords?.length) {return { success: true };}
    try {
      const db    = await this.#getDB();
      const tx    = db.transaction(STORE_VISUAL_ELEMENT_RECTS, 'readwrite');
      const store = tx.objectStore(STORE_VISUAL_ELEMENT_RECTS);
      for (const record of rectRecords) {
        store.put(record);
      }
      await transactionToPromise(tx);
      return { success: true };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message);
      return { success: false, error: writeError.message };
    }
  }

  async loadElementRectsBySession(sessionId) {
    try {
      const db      = await this.#getDB();
      const tx      = db.transaction(STORE_VISUAL_ELEMENT_RECTS, 'readonly');
      const records = await requestToPromise(
        tx.objectStore(STORE_VISUAL_ELEMENT_RECTS).index('by_session').getAll(IDBKeyRange.only(sessionId))
      );

      const out = new Map();
      for (const record of (records ?? [])) {
        if (!out.has(record.elementKey)) {
          out.set(record.elementKey, {});
        }
        out.get(record.elementKey)[record.tabRole] = record;
      }
      return out;
    } catch (readError) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
      return new Map();
    }
  }

  deleteVisualDataBySession(sessionId) {
    return this.#enqueue(() => this.#deleteVisualDataBySessionInner(sessionId));
  }

  async #deleteVisualDataBySessionInner(sessionId) {
    try {
      const db = await this.#getDB();

      const [blobKeys, kfKeys, rectKeys] = await Promise.all([
        this.#getAllKeysByIndex(db, STORE_VISUAL_BLOBS,         'by_comparisonId', sessionId),
        this.#getAllKeysByIndex(db, STORE_VISUAL_KEYFRAMES,     'by_session',      sessionId),
        this.#getAllKeysByIndex(db, STORE_VISUAL_ELEMENT_RECTS, 'by_session',      sessionId)
      ]);

      const hasData = blobKeys.length || kfKeys.length || rectKeys.length;
      if (!hasData) {return { success: true };}

      const stores  = [STORE_VISUAL_BLOBS, STORE_VISUAL_KEYFRAMES, STORE_VISUAL_ELEMENT_RECTS];
      const writeTx = db.transaction(stores, 'readwrite');

      for (const k of blobKeys) {writeTx.objectStore(STORE_VISUAL_BLOBS).delete(k);}
      for (const k of kfKeys)   {writeTx.objectStore(STORE_VISUAL_KEYFRAMES).delete(k);}
      for (const k of rectKeys) {writeTx.objectStore(STORE_VISUAL_ELEMENT_RECTS).delete(k);}

      await transactionToPromise(writeTx);
      return { success: true };
    } catch (deleteError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, deleteError.message, { sessionId });
      return { success: false, error: deleteError.message };
    }
  }

  async #getAllKeysByIndex(db, storeName, indexName, value) {
    try {
      const tx = db.transaction(storeName, 'readonly');
      return await requestToPromise(
        tx.objectStore(storeName).index(indexName).getAllKeys(IDBKeyRange.only(value))
      ) ?? [];
    } catch {
      return [];
    }
  }

  async checkQuota() {
    try {
      if (!navigator.storage?.estimate) {
        return { bytesInUse: 0, quota: 0, percentUsed: 0, available: 0 };
      }
      const { usage, quota } = await navigator.storage.estimate();
      const percentUsed = quota > 0 ? (usage / quota) * 100 : 0;
      return { bytesInUse: usage, quota, percentUsed, available: quota - usage };
    } catch {
      return null;
    }
  }
}

export { buildPairKey, IDBRepository };

const storage = new IDBRepository();
storage.applyPendingOperations();
export default storage;