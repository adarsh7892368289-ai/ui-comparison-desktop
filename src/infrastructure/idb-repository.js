import { get } from '../config/defaults.js';
import { ERROR_CODES, errorTracker } from './error-tracker.js';
import logger from './logger.js';
import { performanceMonitor } from './performance-monitor.js';

const DB_NAME = 'ui_comparison_db';
const DB_VERSION = 10;
const STORE_REPORTS = 'reports';
const STORE_ELEMENTS = 'elements';
const STORE_COMPARISONS = 'comparisons';
const STORE_COMP_DIFFS = 'comparison_diffs';
const STORE_COMP_SUMMARY = 'comparison_summary';
const STORE_VISUAL_BLOBS = 'visual_blobs';
const STORE_VISUAL_KEYFRAMES = 'visual_keyframes';
const STORE_VISUAL_ELEMENT_RECTS = 'visual_element_rects';
const STORE_OP_LOG = 'operation_log';
const STORE_APP_META = 'app_meta';
const STORE_BULK_JOBS = 'bulk_jobs';
const STORE_BULK_PAIRS = 'bulk_pairs';
const STORE_SAUCE_JOBS = 'sauce_jobs';
const META_KEY_V5_DATA_CLEARED = 'v5_upgrade_data_cleared_notice';
const MAX_COMPARISONS = 20;
const BULK_MAX_RETAINED_JOBS = 10;
const OP_STATUS_PENDING = 'PENDING';
const OP_STATUS_COMPLETE = 'COMPLETE';
const OP_STATUS_FAILED = 'FAILED';
const CIRCUIT_BREAKER_LIMIT = 3;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
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
  reportStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  reportStore.createIndex('by_url', 'url', { unique: false });
  reportStore.createIndex('by_url_ts', ['url', 'timestamp'], { unique: false });
  db.createObjectStore(STORE_ELEMENTS, { keyPath: 'reportId' });
}

function buildComparisonStores(db) {
  const compStore = db.createObjectStore(STORE_COMPARISONS, { keyPath: 'id' });
  compStore.createIndex('by_pair', 'pairKey', { unique: true });
  compStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  compStore.createIndex('by_baseline', 'baselineId', { unique: false });
  compStore.createIndex('by_compare', 'compareId', { unique: false });
  db.createObjectStore(STORE_COMP_DIFFS, { keyPath: 'comparisonId' });
}

function buildAuxStores(db) {
  if (!db.objectStoreNames.contains(STORE_COMP_SUMMARY)) {
    const summaryStore = db.createObjectStore(STORE_COMP_SUMMARY, { keyPath: 'comparisonId' });
    summaryStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  }

  if (!db.objectStoreNames.contains(STORE_VISUAL_BLOBS)) {
    const blobStore = db.createObjectStore(STORE_VISUAL_BLOBS, { keyPath: 'key' });
    blobStore.createIndex('by_comparisonId', 'comparisonId', { unique: false });
    blobStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  }

  if (!db.objectStoreNames.contains(STORE_OP_LOG)) {
    const logStore = db.createObjectStore(STORE_OP_LOG, { keyPath: 'id' });
    logStore.createIndex('by_status', 'status', { unique: false });
    logStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  }
}

function upgradeToV5(upgradeTx) {
  upgradeTx.objectStore(STORE_COMPARISONS).
  createIndex('by_triple', ['baselineId', 'compareId', 'mode'], { unique: true });

  const reportStore = upgradeTx.objectStore(STORE_REPORTS);
  const logStore = upgradeTx.objectStore(STORE_OP_LOG);
  const reportIds = [];

  const cursorReq = reportStore.openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      reportIds.push(cursor.value.id);
      cursor.continue();
    } else {
      logStore.put({
        id: crypto.randomUUID(),
        operation: 'PRE_UPGRADE_V5_BACKUP',
        payload: { reportCount: reportIds.length, reportIds, timestamp: Date.now() },
        status: OP_STATUS_COMPLETE,
        timestamp: new Date().toISOString()
      });

      const stalePurge = [STORE_REPORTS, STORE_ELEMENTS, STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY];
      for (const storeName of stalePurge) {
        upgradeTx.objectStore(storeName).clear();
      }
    }
  };

  upgradeTx.addEventListener('complete', () => {
    const db = upgradeTx.db;
    if (!db.objectStoreNames.contains(STORE_APP_META)) {return;}
    const tx = db.transaction([STORE_APP_META], 'readwrite');
    tx.objectStore(STORE_APP_META).put({
      key: META_KEY_V5_DATA_CLEARED,
      pending: true,
      at: Date.now()
    });
  });
}

function upgradeToV6(db) {
  const kfStore = db.createObjectStore(STORE_VISUAL_KEYFRAMES, { keyPath: 'id' });
  kfStore.createIndex('by_session', 'sessionId', { unique: false });

  const rectStore = db.createObjectStore(STORE_VISUAL_ELEMENT_RECTS, { keyPath: 'id' });
  rectStore.createIndex('by_session', 'sessionId', { unique: false });
  rectStore.createIndex('by_session_element', ['sessionId', 'elementKey'], { unique: false });
}

function upgradeToV7(db, upgradeTx) {
  if (!db.objectStoreNames.contains(STORE_VISUAL_BLOBS)) {return;}
  const blobStore = upgradeTx.objectStore(STORE_VISUAL_BLOBS);
  const req = blobStore.openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) {return;}
    const record = cursor.value;
    if (!record.key.includes(':') && record.comparisonId) {
      const newKey = `${record.comparisonId}:${record.key}`;
      cursor.delete();
      blobStore.put({ ...record, key: newKey });
    }
    cursor.continue();
  };
}

function upgradeToV8(db) {
  if (!db.objectStoreNames.contains(STORE_APP_META)) {
    db.createObjectStore(STORE_APP_META, { keyPath: 'key' });
  }
}

function upgradeToV9(db, upgradeTx) {
  if (!db.objectStoreNames.contains(STORE_BULK_JOBS)) {
    const jobsStore = db.createObjectStore(STORE_BULK_JOBS, { keyPath: 'id' });
    jobsStore.createIndex('by_createdAt', 'createdAt', { unique: false });
    jobsStore.createIndex('by_status', 'status', { unique: false });
  }

  if (!db.objectStoreNames.contains(STORE_BULK_PAIRS)) {
    const pairsStore = db.createObjectStore(STORE_BULK_PAIRS, { keyPath: 'id' });
    pairsStore.createIndex('by_jobId', 'jobId', { unique: false });
    pairsStore.createIndex('by_jobId_status', ['jobId', 'status'], { unique: false });
    pairsStore.createIndex('by_jobId_pairIndex', ['jobId', 'pairIndex'], { unique: false });
  }

  if (db.objectStoreNames.contains(STORE_REPORTS)) {
    const reportStore = upgradeTx.objectStore(STORE_REPORTS);
    if (!reportStore.indexNames.contains('by_bulkJobId')) {
      reportStore.createIndex('by_bulkJobId', 'bulkJobId', { unique: false });
    }
    if (!reportStore.indexNames.contains('by_extractionKey')) {
      reportStore.createIndex('by_extractionKey', 'extractionKey', { unique: false });
    }
  }

  if (db.objectStoreNames.contains(STORE_COMPARISONS)) {
    const compStore = upgradeTx.objectStore(STORE_COMPARISONS);
    if (!compStore.indexNames.contains('by_bulkJobId')) {
      compStore.createIndex('by_bulkJobId', 'bulkJobId', { unique: false });
    }
  }
}

function upgradeToV10(db) {
  if (!db.objectStoreNames.contains(STORE_SAUCE_JOBS)) {
    const store = db.createObjectStore(STORE_SAUCE_JOBS, { keyPath: 'id' });
    store.createIndex('by_status', 'status', { unique: false });
    store.createIndex('by_createdAt', 'createdAt', { unique: false });
  }
}

function runUpgrade(db, upgradeTx, oldVersion) {
  if (oldVersion < 1) {buildReportStores(db);}
  if (oldVersion < 2) {buildComparisonStores(db);}
  if (oldVersion < 4) {buildAuxStores(db);}
  if (oldVersion < 8) {upgradeToV8(db);}
  if (oldVersion < 5) {upgradeToV5(upgradeTx);}
  if (oldVersion < 6) {upgradeToV6(db);}
  if (oldVersion < 7) {upgradeToV7(db, upgradeTx);}
  if (oldVersion < 9) {upgradeToV9(db, upgradeTx);}
  if (oldVersion < 10) {upgradeToV10(db);}
}

class IDBRepository {
  #db = null;
  #opening = null;
  #writeQueue = Promise.resolve();
  #consecutiveFailures = 0;
  #circuitOpen = false;

  #handleWriteFailure(err) {
    this.#consecutiveFailures += 1;
    logger.error('IDB write failure recorded', {
      error: err.message,
      consecutiveFailures: this.#consecutiveFailures,
      limit: CIRCUIT_BREAKER_LIMIT
    });
    trackError(ERROR_CODES.STORAGE_WRITE_FAILED, err.message);
    if (this.#consecutiveFailures >= CIRCUIT_BREAKER_LIMIT) {
      this.#circuitOpen = true;
      logger.error('IDB circuit breaker opened — write queue halted', {
        limit: CIRCUIT_BREAKER_LIMIT
      });
      window.dispatchEvent(new CustomEvent('storage-degraded', {
        detail: {
          reason: 'CIRCUIT_OPEN',
          consecutiveFailures: this.#consecutiveFailures,
          limit: CIRCUIT_BREAKER_LIMIT,
          openedAt: Date.now()
        }
      }));
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

        this.#db = openedDb;
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
    return this.#enqueue(performanceMonitor.wrap('idb.saveReport', () => this.#saveReportInner(report)));
  }

  async #saveReportInner(report) {
    const maxReports = get('storage.maxReports');
    const { elements, extractionKey, ...rest } = report;
    const meta = extractionKey === undefined ?
    { ...rest } :
    { ...rest, extractionKey };
    const logId = crypto.randomUUID();

    try {
      const db = await this.#getDB();
      await this.#writeWalEntry(db, logId, 'SAVE_REPORT', { report });
      await this.#writeReportWithEviction(db, meta, elements, meta.id, maxReports);
      await this.#completeWalEntry(db, logId);
      return { success: true, id: meta.id };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message, { id: meta.id });
      return { success: false, error: writeError.message };
    }
  }

  #writeReportWithEviction(db, meta, elements, reportId, maxReports) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_REPORTS, STORE_ELEMENTS], 'readwrite');
      const reportStore = tx.objectStore(STORE_REPORTS);
      const elementStore = tx.objectStore(STORE_ELEMENTS);

      transactionToPromise(tx).then(resolve).catch(reject);

      const totalReq = reportStore.count();
      const bulkReq = reportStore.index('by_bulkJobId').count();
      let totalCount = null;
      let bulkCount = null;

      const proceed = () => {
        if (totalCount === null || bulkCount === null) {return;}
        const nonBulkCount = totalCount - bulkCount;
        const isBulkWrite = meta.bulkJobId != null;
        const projected = isBulkWrite ? nonBulkCount : nonBulkCount + 1;
        const excess = projected - maxReports;
        const reportCtx = { meta, elements, id: reportId };
        if (excess <= 0) {
          commitReportWrite(reportStore, elementStore, reportCtx);
          return;
        }
        this.#evictReports(reportStore, elementStore, reportCtx, excess);
      };

      totalReq.onerror = () => tx.abort();
      bulkReq.onerror = () => tx.abort();
      totalReq.onsuccess = () => {totalCount = totalReq.result;proceed();};
      bulkReq.onsuccess = () => {bulkCount = bulkReq.result;proceed();};
    });
  }

  #evictReports(reportStore, elementStore, reportCtx, excess) {
    const cursorReq = reportStore.index('by_timestamp').openCursor(null, 'next');
    let deleted = 0;

    cursorReq.onerror = () => reportStore.transaction.abort();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && deleted < excess) {
        if (cursor.value?.bulkJobId != null) {
          cursor.continue();
          return;
        }
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
    return performanceMonitor.wrap('idb.loadReports', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_REPORTS, 'readonly');
        return collectCursor(tx.objectStore(STORE_REPORTS).index('by_timestamp'), 'prev');
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
        return [];
      }
    })();
  }

  async loadReportElements(reportId) {
    return performanceMonitor.wrap('idb.loadReportElements', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_ELEMENTS, 'readonly');
        const record = await requestToPromise(tx.objectStore(STORE_ELEMENTS).get(reportId));
        return record?.data ?? [];
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message, { reportId });
        return [];
      }
    })();
  }

  deleteReport(id) {
    return this.#enqueue(performanceMonitor.wrap('idb.deleteReport', () => this.#deleteReportInner(id)));
  }

  async #deleteReportInner(id) {
    try {
      const db = await this.#getDB();
      const compIdsToDelete = await this.#getComparisonIdsByReportId(db, id);

      const stores = [
      STORE_REPORTS, STORE_ELEMENTS,
      STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY,
      STORE_VISUAL_BLOBS, STORE_VISUAL_KEYFRAMES, STORE_VISUAL_ELEMENT_RECTS];

      const tx = db.transaction(stores, 'readwrite');

      tx.objectStore(STORE_REPORTS).delete(id);
      tx.objectStore(STORE_ELEMENTS).delete(id);

      for (const compId of compIdsToDelete) {
        tx.objectStore(STORE_COMPARISONS).delete(compId);
        tx.objectStore(STORE_COMP_DIFFS).delete(compId);
        tx.objectStore(STORE_COMP_SUMMARY).delete(compId);

        const blobStore = tx.objectStore(STORE_VISUAL_BLOBS);
        const blobReq = blobStore.index('by_comparisonId').openKeyCursor(IDBKeyRange.only(compId));
        blobReq.onsuccess = () => {
          const cursor = blobReq.result;
          if (cursor) {blobStore.delete(cursor.primaryKey);cursor.continue();}
        };

        const kfStore = tx.objectStore(STORE_VISUAL_KEYFRAMES);
        const kfReq = kfStore.index('by_session').openKeyCursor(IDBKeyRange.only(compId));
        kfReq.onsuccess = () => {
          const cursor = kfReq.result;
          if (cursor) {kfStore.delete(cursor.primaryKey);cursor.continue();}
        };

        const rectStore = tx.objectStore(STORE_VISUAL_ELEMENT_RECTS);
        const rectReq = rectStore.index('by_session').openKeyCursor(IDBKeyRange.only(compId));
        rectReq.onsuccess = () => {
          const cursor = rectReq.result;
          if (cursor) {rectStore.delete(cursor.primaryKey);cursor.continue();}
        };
      }

      await transactionToPromise(tx);
      return { success: true };
    } catch (deleteError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, deleteError.message, { id });
      return { success: false, error: deleteError.message };
    }
  }

  deleteReportsBatch(ids) {
    return this.#enqueue(performanceMonitor.wrap('idb.deleteReportsBatch', () => this.#deleteReportsBatchInner(ids)));
  }

  async #deleteReportsBatchInner(ids) {
    if (!ids?.length) {return { success: true, deletedCount: 0 };}
    try {
      const db = await this.#getDB();
      const idSet = new Set(ids);

      const stores = [
      STORE_REPORTS, STORE_ELEMENTS,
      STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY,
      STORE_VISUAL_BLOBS, STORE_VISUAL_KEYFRAMES, STORE_VISUAL_ELEMENT_RECTS,
      STORE_BULK_JOBS, STORE_BULK_PAIRS];

      const tx = db.transaction(stores, 'readwrite');

      const compStore = tx.objectStore(STORE_COMPARISONS);
      const compIds = new Set();
      const bulkJobCounts = new Map();

      const collectCompAndBulk = () => new Promise((resolve) => {
        const reportStore = tx.objectStore(STORE_REPORTS);
        let pending = idSet.size;
        if (pending === 0) {resolve();return;}

        for (const reportId of idSet) {
          const req = reportStore.get(reportId);
          req.onsuccess = () => {
            const report = req.result;
            if (report?.bulkJobId) {
              bulkJobCounts.set(report.bulkJobId, (bulkJobCounts.get(report.bulkJobId) ?? 0) + 1);
            }
            pending--;
            if (pending === 0) {resolve();}
          };
          req.onerror = () => {pending--;if (pending === 0) {resolve();}};
        }
      });

      const collectCompIds = () => new Promise((resolve) => {
        let pending = idSet.size * 2;
        if (pending === 0) {resolve();return;}

        for (const reportId of idSet) {
          const range = IDBKeyRange.only(reportId);
          const blReq = compStore.index('by_baseline').getAllKeys(range);
          blReq.onsuccess = () => {
            for (const k of blReq.result ?? []) {compIds.add(k);}
            pending--;
            if (pending === 0) {resolve();}
          };
          blReq.onerror = () => {pending--;if (pending === 0) {resolve();}};

          const cpReq = compStore.index('by_compare').getAllKeys(range);
          cpReq.onsuccess = () => {
            for (const k of cpReq.result ?? []) {compIds.add(k);}
            pending--;
            if (pending === 0) {resolve();}
          };
          cpReq.onerror = () => {pending--;if (pending === 0) {resolve();}};
        }
      });

      await Promise.all([collectCompAndBulk(), collectCompIds()]);

      for (const reportId of idSet) {
        tx.objectStore(STORE_REPORTS).delete(reportId);
        tx.objectStore(STORE_ELEMENTS).delete(reportId);
      }

      for (const compId of compIds) {
        compStore.delete(compId);
        tx.objectStore(STORE_COMP_DIFFS).delete(compId);
        tx.objectStore(STORE_COMP_SUMMARY).delete(compId);

        const blobStore = tx.objectStore(STORE_VISUAL_BLOBS);
        const blobReq = blobStore.index('by_comparisonId').openKeyCursor(IDBKeyRange.only(compId));
        blobReq.onsuccess = () => {
          const cursor = blobReq.result;
          if (cursor) {blobStore.delete(cursor.primaryKey);cursor.continue();}
        };

        const kfStore = tx.objectStore(STORE_VISUAL_KEYFRAMES);
        const kfReq = kfStore.index('by_session').openKeyCursor(IDBKeyRange.only(compId));
        kfReq.onsuccess = () => {
          const cursor = kfReq.result;
          if (cursor) {kfStore.delete(cursor.primaryKey);cursor.continue();}
        };

        const rectStore = tx.objectStore(STORE_VISUAL_ELEMENT_RECTS);
        const rectReq = rectStore.index('by_session').openKeyCursor(IDBKeyRange.only(compId));
        rectReq.onsuccess = () => {
          const cursor = rectReq.result;
          if (cursor) {rectStore.delete(cursor.primaryKey);cursor.continue();}
        };
      }


      for (const [bulkJobId] of bulkJobCounts) {
        const allReportsReq = tx.objectStore(STORE_REPORTS).index('by_bulkJobId').getAllKeys(IDBKeyRange.only(bulkJobId));
        allReportsReq.onsuccess = () => {
          const remaining = (allReportsReq.result ?? []).filter((k) => !idSet.has(k));
          if (remaining.length === 0) {
            tx.objectStore(STORE_BULK_JOBS).delete(bulkJobId);
            const pairReq = tx.objectStore(STORE_BULK_PAIRS).index('by_jobId').openKeyCursor(IDBKeyRange.only(bulkJobId));
            pairReq.onsuccess = () => {
              const cursor = pairReq.result;
              if (cursor) {tx.objectStore(STORE_BULK_PAIRS).delete(cursor.primaryKey);cursor.continue();}
            };
          }
        };
      }

      await transactionToPromise(tx);
      return { success: true, deletedCount: idSet.size };
    } catch (deleteError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, deleteError.message, { ids });
      return { success: false, error: deleteError.message };
    }
  }

  async #getComparisonIdsByReportId(db, reportId) {
    try {
      const tx = db.transaction(STORE_COMPARISONS, 'readonly');
      const store = tx.objectStore(STORE_COMPARISONS);
      const range = IDBKeyRange.only(reportId);
      const [baselineKeys, compareKeys] = await Promise.all([
      requestToPromise(store.index('by_baseline').getAllKeys(range)),
      requestToPromise(store.index('by_compare').getAllKeys(range))]
      );
      return [...new Set([...(baselineKeys ?? []), ...(compareKeys ?? [])])];
    } catch {
      return [];
    }
  }

  deleteAllReports() {
    return this.#enqueue(performanceMonitor.wrap('idb.deleteAllReports', () => this.#deleteAllInner()));
  }

  async #deleteAllInner() {
    try {
      const db = await this.#getDB();
      const stores = [
      STORE_REPORTS, STORE_ELEMENTS,
      STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY,
      STORE_VISUAL_BLOBS, STORE_VISUAL_KEYFRAMES, STORE_VISUAL_ELEMENT_RECTS];

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
    return this.#enqueue(performanceMonitor.wrap('idb.saveComparison', () => this.#saveComparisonInner(meta, slimResults)));
  }

  async #saveComparisonInner(meta, slimResults) {
    const logId = crypto.randomUUID();
    try {
      const db = await this.#getDB();
      await this.#writeWalEntry(db, logId, 'SAVE_COMPARISON', { meta, slimResults });
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
      const tx = db.transaction(storeNames, 'readwrite');
      const writeCtx = {
        comp: tx.objectStore(STORE_COMPARISONS),
        diffs: tx.objectStore(STORE_COMP_DIFFS),
        summary: tx.objectStore(STORE_COMP_SUMMARY)
      };

      transactionToPromise(tx).then(resolve).catch(reject);

      const pairReq = writeCtx.comp.index('by_pair').get(meta.pairKey);
      pairReq.onerror = () => tx.abort();
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
    const totalReq = writeCtx.comp.count();
    const bulkReq = writeCtx.comp.index('by_bulkJobId').count();
    let totalCount = null;
    let bulkCount = null;

    const proceed = () => {
      if (totalCount === null || bulkCount === null) {return;}
      const nonBulkCount = totalCount - bulkCount;
      const isBulkWrite = meta.bulkJobId != null;
      const projected = isBulkWrite ? nonBulkCount : nonBulkCount + 1;
      const excess = projected - MAX_COMPARISONS;
      if (excess <= 0) {
        writeAll();
        return;
      }
      const cursorReq = writeCtx.comp.index('by_timestamp').openCursor(null, 'next');
      let deleted = 0;
      cursorReq.onerror = () => tx.abort();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && deleted < excess) {
          if (cursor.value?.bulkJobId != null) {
            cursor.continue();
            return;
          }
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

    totalReq.onerror = () => tx.abort();
    bulkReq.onerror = () => tx.abort();
    totalReq.onsuccess = () => {totalCount = totalReq.result;proceed();};
    bulkReq.onsuccess = () => {bulkCount = bulkReq.result;proceed();};
  }

  async #writeWalEntry(db, id, operation, payload) {
    const tx = db.transaction(STORE_OP_LOG, 'readwrite');
    tx.objectStore(STORE_OP_LOG).put({
      id,
      operation,
      payload,
      status: OP_STATUS_PENDING,
      timestamp: new Date().toISOString()
    });
    await transactionToPromise(tx);
  }

  async #completeWalEntry(db, id) {
    const tx = db.transaction(STORE_OP_LOG, 'readwrite');
    tx.objectStore(STORE_OP_LOG).delete(id);
    await transactionToPromise(tx);
  }

  async #failWalEntry(db, id) {
    const tx = db.transaction(STORE_OP_LOG, 'readwrite');
    const store = tx.objectStore(STORE_OP_LOG);
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) {
        store.put({ ...req.result, status: OP_STATUS_FAILED });
      }
    };
    await transactionToPromise(tx);
  }

  async #incrementWalEntry(db, entry) {
    const tx = db.transaction(STORE_OP_LOG, 'readwrite');
    tx.objectStore(STORE_OP_LOG).put({
      ...entry,
      replayCount: (entry.replayCount ?? 0) + 1,
      lastAttempt: Date.now()
    });
    await transactionToPromise(tx);
  }

  async applyPendingOperations() {
    return performanceMonitor.wrap('idb.applyPendingOperations', async () => {
      try {
        const db = await this.#getDB();
        const readTx = db.transaction(STORE_OP_LOG, 'readonly');
        const pending = await requestToPromise(
          readTx.objectStore(STORE_OP_LOG).index('by_status').getAll(IDBKeyRange.only(OP_STATUS_PENDING))
        );

        if (!pending?.length) {return;}

        logger.warn('WAL replay starting', { pendingCount: pending.length });

        let replayed = 0;
        let failed = 0;

        for (const entry of pending) {
          if (entry.operation === 'SAVE_VISUAL_BLOB') {
            await this.#failWalEntry(db, entry.id);
            failed++;
            continue;
          }

          const isKnown = entry.operation === 'SAVE_REPORT' || entry.operation === 'SAVE_COMPARISON';
          if (!isKnown) {
            logger.warn('WAL replay: unknown operation type', { operation: entry.operation });
            await this.#failWalEntry(db, entry.id);
            failed++;
            continue;
          }

          if ((entry.replayCount ?? 0) >= 3) {
            await this.#failWalEntry(db, entry.id);
            window.dispatchEvent(new CustomEvent('storage-degraded', {
              detail: {
                reason: 'WAL_REPLAY_EXHAUSTED',
                entryId: entry.id,
                operation: entry.operation
              }
            }));
            failed++;
            continue;
          }

          await this.#incrementWalEntry(db, entry);

          try {
            if (entry.operation === 'SAVE_REPORT') {
              const { report } = entry.payload;
              const { elements, ...meta } = report;
              await this.#writeReportWithEviction(db, meta, elements, meta.id, get('storage.maxReports'));
            } else {
              const { meta, slimResults } = entry.payload;
              await this.#writeComparisonWithEviction(db, meta, slimResults);
            }

            await this.#completeWalEntry(db, entry.id);
            logger.info('WAL replay: operation replayed', { operation: entry.operation, id: entry.id });
            replayed++;
          } catch (replayError) {
            logger.error('WAL replay: operation failed, will retry on next startup', {
              operation: entry.operation,
              id: entry.id,
              error: replayError.message
            });
          }
        }

        logger.info('WAL replay complete', { replayed, failed });
      } catch (walError) {
        logger.warn('WAL replay check failed', { error: walError.message });
      }
    })();
  }

  async loadComparisonByPair(baselineId, compareId, mode) {
    return performanceMonitor.wrap('idb.loadComparisonByPair', async () => {
      try {
        const db = await this.#getDB();
        const pairKey = buildPairKey(baselineId, compareId, mode);
        const tx = db.transaction(STORE_COMPARISONS, 'readonly');
        const record = await requestToPromise(
          tx.objectStore(STORE_COMPARISONS).index('by_pair').get(pairKey)
        );
        return record ?? null;
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
        return null;
      }
    })();
  }

  async loadComparisonDiffs(comparisonId) {
    return performanceMonitor.wrap('idb.loadComparisonDiffs', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_COMP_DIFFS, 'readonly');
        const record = await requestToPromise(tx.objectStore(STORE_COMP_DIFFS).get(comparisonId));
        return record?.results ?? [];
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
        return [];
      }
    })();
  }

  saveVisualBlob(key, blob, comparisonId) {
    return this.#enqueue(performanceMonitor.wrap('idb.saveVisualBlob', () => this.#saveVisualBlobInner(key, blob, comparisonId)));
  }

  async #saveVisualBlobInner(key, blob, comparisonId) {
    const logId = crypto.randomUUID();
    try {
      const db = await this.#getDB();
      await this.#writeWalEntry(db, logId, 'SAVE_VISUAL_BLOB', { key, comparisonId });
      const tx = db.transaction(STORE_VISUAL_BLOBS, 'readwrite');
      tx.objectStore(STORE_VISUAL_BLOBS).put({ key, blob, comparisonId, timestamp: new Date().toISOString() });
      await transactionToPromise(tx);
      await this.#completeWalEntry(db, logId);
      return { success: true };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message);
      return { success: false, error: writeError.message };
    }
  }

  async loadVisualBlob(key) {
    return performanceMonitor.wrap('idb.loadVisualBlob', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_VISUAL_BLOBS, 'readonly');
        const record = await requestToPromise(tx.objectStore(STORE_VISUAL_BLOBS).get(key));
        return record?.blob ?? null;
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
        return null;
      }
    })();
  }

  deleteVisualBlobsByComparisonId(comparisonId) {
    return this.#enqueue(() => this.#deleteVisualBlobsInner(comparisonId));
  }

  async #deleteVisualBlobsInner(comparisonId) {
    try {
      const db = await this.#getDB();
      const readTx = db.transaction(STORE_VISUAL_BLOBS, 'readonly');
      const blobKeys = await requestToPromise(
        readTx.objectStore(STORE_VISUAL_BLOBS).index('by_comparisonId').getAllKeys(IDBKeyRange.only(comparisonId))
      );
      if (!blobKeys?.length) {
        return { success: true };
      }
      const writeTx = db.transaction(STORE_VISUAL_BLOBS, 'readwrite');
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
    return this.#enqueue(performanceMonitor.wrap('idb.saveVisualKeyframe', () => this.#saveVisualKeyframeInner(keyframe)));
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
      const db = await this.#getDB();
      const tx = db.transaction(STORE_VISUAL_KEYFRAMES, 'readonly');
      const records = await requestToPromise(
        tx.objectStore(STORE_VISUAL_KEYFRAMES).index('by_session').getAll(IDBKeyRange.only(sessionId))
      );
      return new Map((records ?? []).map((r) => [r.id, r]));
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
    return this.#enqueue(performanceMonitor.wrap('idb.saveVisualElementRects', () => this.#saveVisualElementRectsInner(rectRecords)));
  }

  async #saveVisualElementRectsInner(rectRecords) {
    if (!rectRecords?.length) {return { success: true };}
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_VISUAL_ELEMENT_RECTS, 'readwrite');
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
      const db = await this.#getDB();
      const tx = db.transaction(STORE_VISUAL_ELEMENT_RECTS, 'readonly');
      const records = await requestToPromise(
        tx.objectStore(STORE_VISUAL_ELEMENT_RECTS).index('by_session').getAll(IDBKeyRange.only(sessionId))
      );

      const out = new Map();
      for (const record of records ?? []) {
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
      this.#getAllKeysByIndex(db, STORE_VISUAL_BLOBS, 'by_comparisonId', sessionId),
      this.#getAllKeysByIndex(db, STORE_VISUAL_KEYFRAMES, 'by_session', sessionId),
      this.#getAllKeysByIndex(db, STORE_VISUAL_ELEMENT_RECTS, 'by_session', sessionId)]
      );

      const hasData = blobKeys.length || kfKeys.length || rectKeys.length;
      if (!hasData) {return { success: true };}

      const stores = [STORE_VISUAL_BLOBS, STORE_VISUAL_KEYFRAMES, STORE_VISUAL_ELEMENT_RECTS];
      const writeTx = db.transaction(stores, 'readwrite');

      for (const k of blobKeys) {writeTx.objectStore(STORE_VISUAL_BLOBS).delete(k);}
      for (const k of kfKeys) {writeTx.objectStore(STORE_VISUAL_KEYFRAMES).delete(k);}
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
      return (await requestToPromise(
        tx.objectStore(storeName).index(indexName).getAllKeys(IDBKeyRange.only(value))
      )) ?? [];
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
      const percentUsed = quota > 0 ? usage / quota * 100 : 0;
      return { bytesInUse: usage, quota, percentUsed, available: quota - usage };
    } catch {
      return null;
    }
  }

  saveBulkJob(job) {
    return this.#enqueue(performanceMonitor.wrap('idb.saveBulkJob', () => this.#saveBulkJobInner(job)));
  }

  async #saveBulkJobInner(job) {
    const logId = crypto.randomUUID();
    try {
      const db = await this.#getDB();
      await this.#writeWalEntry(db, logId, 'SAVE_BULK_JOB', { job });

      const readTx = db.transaction(STORE_BULK_JOBS, 'readonly');
      const jobCount = await requestToPromise(readTx.objectStore(STORE_BULK_JOBS).count());
      let oldestIds = [];
      if (jobCount >= BULK_MAX_RETAINED_JOBS) {
        const overflow = jobCount - BULK_MAX_RETAINED_JOBS + 1;
        const evictTx = db.transaction(STORE_BULK_JOBS, 'readonly');
        oldestIds = await this.#collectOldestBulkJobIds(evictTx, overflow, job.id);
      }

      for (const oldId of oldestIds) {
        await this.#deleteBulkJobCascadeInner(oldId);
      }

      const writeTx = db.transaction(STORE_BULK_JOBS, 'readwrite');
      writeTx.objectStore(STORE_BULK_JOBS).put(job);
      await transactionToPromise(writeTx);

      await this.#completeWalEntry(db, logId);
      return { success: true, id: job.id };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message, { id: job?.id });
      return { success: false, error: writeError.message };
    }
  }

  #collectOldestBulkJobIds(tx, count, excludeId) {
    return new Promise((resolve, reject) => {
      const ids = [];
      const req = tx.objectStore(STORE_BULK_JOBS).index('by_createdAt').openCursor(null, 'next');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor && ids.length < count) {
          if (cursor.primaryKey !== excludeId) {
            ids.push(cursor.primaryKey);
          }
          cursor.continue();
        } else {
          resolve(ids);
        }
      };
    });
  }

  updateBulkJob(jobId, patch) {
    return this.#enqueue(performanceMonitor.wrap('idb.updateBulkJob', () => this.#updateBulkJobInner(jobId, patch)));
  }

  async #updateBulkJobInner(jobId, patch) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_BULK_JOBS, 'readwrite');
      const store = tx.objectStore(STORE_BULK_JOBS);
      const existing = await requestToPromise(store.get(jobId));
      if (!existing) {
        return { success: false, error: `Bulk job not found: ${jobId}` };
      }
      store.put({ ...existing, ...patch });
      await transactionToPromise(tx);
      return { success: true, id: jobId };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message, { jobId });
      return { success: false, error: writeError.message };
    }
  }

  saveBulkPair(pair) {
    return this.#enqueue(performanceMonitor.wrap('idb.saveBulkPair', () => this.#saveBulkPairInner(pair)));
  }

  async #saveBulkPairInner(pair) {
    const logId = crypto.randomUUID();
    try {
      const db = await this.#getDB();
      await this.#writeWalEntry(db, logId, 'SAVE_BULK_PAIR', { pair });
      const tx = db.transaction(STORE_BULK_PAIRS, 'readwrite');
      tx.objectStore(STORE_BULK_PAIRS).put(pair);
      await transactionToPromise(tx);
      await this.#completeWalEntry(db, logId);
      return { success: true, id: pair.id };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message, { id: pair?.id });
      return { success: false, error: writeError.message };
    }
  }

  updateBulkPair(pairId, patch) {
    return this.#enqueue(performanceMonitor.wrap('idb.updateBulkPair', () => this.#updateBulkPairInner(pairId, patch)));
  }

  async #updateBulkPairInner(pairId, patch) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_BULK_PAIRS, 'readwrite');
      const store = tx.objectStore(STORE_BULK_PAIRS);
      const existing = await requestToPromise(store.get(pairId));
      if (!existing) {
        return { success: false, error: `Bulk pair not found: ${pairId}` };
      }
      store.put({ ...existing, ...patch });
      await transactionToPromise(tx);
      return { success: true, id: pairId };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message, { pairId });
      return { success: false, error: writeError.message };
    }
  }

  async loadBulkJob(jobId) {
    return performanceMonitor.wrap('idb.loadBulkJob', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_BULK_JOBS, 'readonly');
        const record = await requestToPromise(tx.objectStore(STORE_BULK_JOBS).get(jobId));
        return record ?? null;
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message, { jobId });
        return null;
      }
    })();
  }

  async loadAllBulkJobs() {
    return performanceMonitor.wrap('idb.loadAllBulkJobs', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_BULK_JOBS, 'readonly');
        return collectCursor(tx.objectStore(STORE_BULK_JOBS).index('by_createdAt'), 'prev');
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
        return [];
      }
    })();
  }

  async loadBulkPairsByJob(jobId) {
    return performanceMonitor.wrap('idb.loadBulkPairsByJob', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_BULK_PAIRS, 'readonly');
        const range = IDBKeyRange.bound([jobId, -Infinity], [jobId, Infinity]);
        const recs = await requestToPromise(
          tx.objectStore(STORE_BULK_PAIRS).index('by_jobId_pairIndex').getAll(range)
        );
        return recs ?? [];
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message, { jobId });
        return [];
      }
    })();
  }

  async loadBulkPairsByStatus(jobId, status) {
    return performanceMonitor.wrap('idb.loadBulkPairsByStatus', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_BULK_PAIRS, 'readonly');
        const recs = await requestToPromise(
          tx.objectStore(STORE_BULK_PAIRS).index('by_jobId_status').getAll(IDBKeyRange.only([jobId, status]))
        );
        return recs ?? [];
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message, { jobId, status });
        return [];
      }
    })();
  }

  deleteBulkJobCascade(jobId) {
    return this.#enqueue(performanceMonitor.wrap('idb.deleteBulkJobCascade', () => this.#deleteBulkJobCascadeInner(jobId)));
  }

  async #deleteBulkJobCascadeInner(jobId) {
    try {
      const db = await this.#getDB();

      const readTx = db.transaction([STORE_BULK_PAIRS, STORE_REPORTS, STORE_COMPARISONS], 'readonly');
      const [pairKeys, reportKeys, compKeys] = await Promise.all([
      requestToPromise(readTx.objectStore(STORE_BULK_PAIRS).index('by_jobId').getAllKeys(IDBKeyRange.only(jobId))),
      requestToPromise(readTx.objectStore(STORE_REPORTS).index('by_bulkJobId').getAllKeys(IDBKeyRange.only(jobId))),
      requestToPromise(readTx.objectStore(STORE_COMPARISONS).index('by_bulkJobId').getAllKeys(IDBKeyRange.only(jobId)))]
      );

      const visualLookupTx = db.transaction([STORE_VISUAL_BLOBS, STORE_VISUAL_KEYFRAMES, STORE_VISUAL_ELEMENT_RECTS], 'readonly');
      const visualBlobStore = visualLookupTx.objectStore(STORE_VISUAL_BLOBS);
      const visualKfStore = visualLookupTx.objectStore(STORE_VISUAL_KEYFRAMES);
      const visualRectStore = visualLookupTx.objectStore(STORE_VISUAL_ELEMENT_RECTS);
      const visualBlobKeys = [];
      const visualKfKeys = [];
      const visualRectKeys = [];
      for (const compId of compKeys ?? []) {
        const range = IDBKeyRange.only(compId);
        const [bk, kk, rk] = await Promise.all([
        requestToPromise(visualBlobStore.index('by_comparisonId').getAllKeys(range)),
        requestToPromise(visualKfStore.index('by_session').getAllKeys(range)),
        requestToPromise(visualRectStore.index('by_session').getAllKeys(range))]
        );
        visualBlobKeys.push(...(bk ?? []));
        visualKfKeys.push(...(kk ?? []));
        visualRectKeys.push(...(rk ?? []));
      }

      const stores = [
      STORE_BULK_JOBS, STORE_BULK_PAIRS,
      STORE_REPORTS, STORE_ELEMENTS,
      STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY,
      STORE_VISUAL_BLOBS, STORE_VISUAL_KEYFRAMES, STORE_VISUAL_ELEMENT_RECTS];

      const writeTx = db.transaction(stores, 'readwrite');

      writeTx.objectStore(STORE_BULK_JOBS).delete(jobId);
      for (const k of pairKeys ?? []) {writeTx.objectStore(STORE_BULK_PAIRS).delete(k);}
      for (const k of reportKeys ?? []) {
        writeTx.objectStore(STORE_REPORTS).delete(k);
        writeTx.objectStore(STORE_ELEMENTS).delete(k);
      }
      for (const k of compKeys ?? []) {
        writeTx.objectStore(STORE_COMPARISONS).delete(k);
        writeTx.objectStore(STORE_COMP_DIFFS).delete(k);
        writeTx.objectStore(STORE_COMP_SUMMARY).delete(k);
      }
      for (const k of visualBlobKeys) {writeTx.objectStore(STORE_VISUAL_BLOBS).delete(k);}
      for (const k of visualKfKeys) {writeTx.objectStore(STORE_VISUAL_KEYFRAMES).delete(k);}
      for (const k of visualRectKeys) {writeTx.objectStore(STORE_VISUAL_ELEMENT_RECTS).delete(k);}

      await transactionToPromise(writeTx);
      return { success: true, deletedComparisonIds: compKeys ?? [] };
    } catch (deleteError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, deleteError.message, { jobId });
      return { success: false, error: deleteError.message };
    }
  }

  async loadReportByExtractionKey(extractionKey) {
    return performanceMonitor.wrap('idb.loadReportByExtractionKey', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_REPORTS, 'readonly');
        const recs = await requestToPromise(
          tx.objectStore(STORE_REPORTS).index('by_extractionKey').getAll(IDBKeyRange.only(extractionKey))
        );
        if (!recs?.length) {return null;}
        let newest = recs[0];
        for (const r of recs) {
          if ((r.timestamp ?? 0) > (newest.timestamp ?? 0)) {newest = r;}
        }
        return newest;
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message, { extractionKey });
        return null;
      }
    })();
  }

  async consumeV5UpgradeDataClearedNotice() {
    const LEGACY_LS_KEY = 'ui-compare-v5-upgrade-data-cleared';
    try {
      const db = await this.#getDB();
      if (!db.objectStoreNames.contains(STORE_APP_META)) {
        return false;
      }
      if (typeof localStorage !== 'undefined' && localStorage.getItem(LEGACY_LS_KEY)) {
        localStorage.removeItem(LEGACY_LS_KEY);
        const migTx = db.transaction([STORE_APP_META], 'readwrite');
        migTx.objectStore(STORE_APP_META).put({
          key: META_KEY_V5_DATA_CLEARED,
          pending: true,
          at: Date.now()
        });
        await transactionToPromise(migTx);
      }
      const readTx = db.transaction([STORE_APP_META], 'readonly');
      const rec = await requestToPromise(
        readTx.objectStore(STORE_APP_META).get(META_KEY_V5_DATA_CLEARED)
      );
      if (!rec?.pending) {
        return false;
      }
      const delTx = db.transaction([STORE_APP_META], 'readwrite');
      delTx.objectStore(STORE_APP_META).delete(META_KEY_V5_DATA_CLEARED);
      await transactionToPromise(delTx);
      return true;
    } catch (err) {
      logger.warn('consumeV5UpgradeDataClearedNotice failed', { message: err?.message });
      return false;
    }
  }

  saveSauceJob(job) {
    return this.#enqueue(performanceMonitor.wrap('idb.saveSauceJob', () => this.#saveSauceJobInner(job)));
  }

  async #saveSauceJobInner(job) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_SAUCE_JOBS, 'readwrite');
      tx.objectStore(STORE_SAUCE_JOBS).put(job);
      await transactionToPromise(tx);
      return { success: true, id: job.id };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message, { id: job?.id });
      return { success: false, error: writeError.message };
    }
  }

  updateSauceJob(jobId, patch) {
    return this.#enqueue(performanceMonitor.wrap('idb.updateSauceJob', () => this.#updateSauceJobInner(jobId, patch)));
  }

  async #updateSauceJobInner(jobId, patch) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_SAUCE_JOBS, 'readwrite');
      const store = tx.objectStore(STORE_SAUCE_JOBS);
      const existing = await requestToPromise(store.get(jobId));
      if (!existing) {
        return { success: false, error: `Sauce job not found: ${jobId}` };
      }
      store.put({ ...existing, ...patch });
      await transactionToPromise(tx);
      return { success: true, id: jobId };
    } catch (writeError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, writeError.message, { jobId });
      return { success: false, error: writeError.message };
    }
  }

  async loadSauceJob(jobId) {
    return performanceMonitor.wrap('idb.loadSauceJob', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_SAUCE_JOBS, 'readonly');
        const record = await requestToPromise(tx.objectStore(STORE_SAUCE_JOBS).get(jobId));
        return record ?? null;
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message, { jobId });
        return null;
      }
    })();
  }

  async loadAllSauceJobs() {
    return performanceMonitor.wrap('idb.loadAllSauceJobs', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_SAUCE_JOBS, 'readonly');
        return collectCursor(tx.objectStore(STORE_SAUCE_JOBS).index('by_createdAt'), 'prev');
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
        return [];
      }
    })();
  }

  async loadSauceJobsByStatus(statuses) {
    return performanceMonitor.wrap('idb.loadSauceJobsByStatus', async () => {
      try {
        const db = await this.#getDB();
        const tx = db.transaction(STORE_SAUCE_JOBS, 'readonly');
        const all = await collectCursor(tx.objectStore(STORE_SAUCE_JOBS));
        const set = new Set(statuses);
        return all.filter((j) => set.has(j.status));
      } catch (readError) {
        trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
        return [];
      }
    })();
  }

  deleteSauceJob(jobId) {
    return this.#enqueue(performanceMonitor.wrap('idb.deleteSauceJob', () => this.#deleteSauceJobInner(jobId)));
  }

  async #deleteSauceJobInner(jobId) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_SAUCE_JOBS, 'readwrite');
      tx.objectStore(STORE_SAUCE_JOBS).delete(jobId);
      await transactionToPromise(tx);
      return { success: true };
    } catch (deleteError) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, deleteError.message, { jobId });
      return { success: false, error: deleteError.message };
    }
  }
}

export { buildPairKey, IDBRepository };

const storage = new IDBRepository();
export default storage;