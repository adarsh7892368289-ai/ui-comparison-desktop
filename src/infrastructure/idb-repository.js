/**
 * The only module that reads or writes IndexedDB — no other file opens IDB directly.
 * Runs in the MV3 service worker. All writes are serialised through a single promise
 * chain (#enqueue) to enforce write-ahead log (WAL) ordering. A circuit breaker halts
 * the queue permanently after 3 consecutive failures to prevent a broken IDB from
 * accumulating partial writes across multiple stores.
 * Callers: background.js, compare-workflow.js, visual-workflow.js, export-workflow.js,
 *          import-workflow.js, report-manager.js
 */

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
// 3 is intentionally low — repeated failures mean IDB is degraded, not a transient blip.
const CIRCUIT_BREAKER_LIMIT      = 3;

/**
 * Wraps a single IDB request in a Promise. Safe for reads only.
 * Resolves on `onsuccess`, which fires before the data is safely on disk.
 * Use transactionToPromise instead to confirm writes are durable.
 */
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

/**
 * Wraps an IDB transaction in a Promise that resolves only after the engine confirms
 * the write is safely stored on disk. Always use this (not requestToPromise) for writes —
 * `onsuccess` on the final put() fires before the data would survive a process kill.
 */
function transactionToPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/**
 * Builds the unique string key that identifies a comparison by both report IDs and mode.
 * Treat this format as a schema constant — changing it invalidates all existing `by_pair`
 * index entries without a migration.
 */
function buildPairKey(baselineId, compareId, mode) {
  return `${baselineId}_${compareId}_${mode}`;
}

/** Forwards an error to the central error tracker with its code and context. */
function trackError(code, message, context = {}) {
  errorTracker.track({ code, message, context });
}

/**
 * Walks an IDB cursor from start to end and collects every record into an array.
 * @param {IDBIndex|IDBObjectStore} source
 * @param {IDBCursorDirection} [direction='next']
 * @returns {Promise<Object[]>}
 */
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

/**
 * Issues put() calls for a report and its elements inside an already-open transaction.
 * Must be called synchronously inside a cursor callback — IDB auto-closes the transaction
 * the moment execution yields to async code (await, setTimeout), silently discarding any
 * writes issued after that point.
 */
function commitReportWrite(reportStore, elementStore, reportCtx) {
  reportStore.put(reportCtx.meta);
  if (reportCtx.elements?.length) {
    elementStore.put({ reportId: reportCtx.id, data: reportCtx.elements });
  }
}

/**
 * Creates the reports and elements object stores during a DB schema upgrade.
 * The `by_url_ts` compound index enables "most recent capture for a URL" queries via
 * IDBKeyRange.bound([url,''], [url,'\uffff']) without a full store scan.
 */
function buildReportStores(db) {
  const reportStore = db.createObjectStore(STORE_REPORTS, { keyPath: 'id' });
  reportStore.createIndex('by_timestamp', 'timestamp',          { unique: false });
  reportStore.createIndex('by_url',       'url',                { unique: false });
  reportStore.createIndex('by_url_ts',    ['url', 'timestamp'], { unique: false });
  db.createObjectStore(STORE_ELEMENTS, { keyPath: 'reportId' });
}

/**
 * Creates the comparisons and diffs object stores during a DB schema upgrade.
 * The `by_pair` index is unique — calling put() with a duplicate pairKey throws a
 * ConstraintError. Always delete the existing record first (see #writeComparisonWithEviction).
 */
function buildComparisonStores(db) {
  const compStore = db.createObjectStore(STORE_COMPARISONS, { keyPath: 'id' });
  compStore.createIndex('by_pair',      'pairKey',    { unique: true  });
  compStore.createIndex('by_timestamp', 'timestamp',  { unique: false });
  compStore.createIndex('by_baseline',  'baselineId', { unique: false });
  compStore.createIndex('by_compare',   'compareId',  { unique: false });
  db.createObjectStore(STORE_COMP_DIFFS, { keyPath: 'comparisonId' });
}

/** Creates the summary, visual blob, and write-ahead log stores during a DB schema upgrade. */
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

/**
 * Migrates to schema v5. Clears all existing data because pre-v5 records lack the
 * `mode` field required by the new `by_triple` unique index — partial data cannot be recovered.
 */
function upgradeToV5(upgradeTx) {
  upgradeTx.objectStore(STORE_COMPARISONS)
    .createIndex('by_triple', ['baselineId', 'compareId', 'mode'], { unique: true });

  const stalePurge = [STORE_REPORTS, STORE_ELEMENTS, STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY];
  for (const storeName of stalePurge) {
    upgradeTx.objectStore(storeName).clear();
  }
}

/** Creates the keyframes and element rects stores added in schema v6 for visual diff support. */
function upgradeToV6(db) {
  const kfStore = db.createObjectStore(STORE_VISUAL_KEYFRAMES, { keyPath: 'id' });
  kfStore.createIndex('by_session', 'sessionId', { unique: false });

  const rectStore = db.createObjectStore(STORE_VISUAL_ELEMENT_RECTS, { keyPath: 'id' });
  rectStore.createIndex('by_session',         'sessionId',                 { unique: false });
  rectStore.createIndex('by_session_element', ['sessionId', 'elementKey'], { unique: false });
}

/**
 * Runs only the schema upgrade steps needed to reach the current DB version.
 * Each step is guarded so only missing stores are created — safe to run on any
 * version from 0 to current. Note: v3 was never shipped; users on v2 skip to v4.
 */
function runUpgrade(db, upgradeTx, oldVersion) {
  if (oldVersion < 1) {buildReportStores(db);}
  if (oldVersion < 2) {buildComparisonStores(db);}
  if (oldVersion < 4) {buildAuxStores(db);}
  if (oldVersion < 5) {upgradeToV5(upgradeTx);}
  if (oldVersion < 6) {upgradeToV6(db);}
}

/**
 * Manages the IDB connection, write queue, write-ahead log (WAL), and circuit breaker.
 * Does not own schema migration (runUpgrade) or error display (error-tracker.js).
 *
 * Always use the exported `storage` singleton — a second instance has its own isolated
 * queue and circuit breaker, silently bypassing both safeguards.
 */
class IDBRepository {
  #db                  = null;
  #opening             = null;
  #writeQueue          = Promise.resolve(); // Pre-resolved so the first enqueued write runs immediately.
  #consecutiveFailures = 0;
  #circuitOpen         = false;

  /**
   * Records a write failure and permanently opens the circuit breaker after
   * CIRCUIT_BREAKER_LIMIT consecutive failures. Once open, the circuit stays open
   * for the session — a degraded IDB kept running would turn each failed multi-store
   * write into a progressively worse partial state.
   */
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

  /**
   * Adds a write operation to the serial queue so only one runs at a time.
   * Without this serialisation, two concurrent saveComparison calls could both
   * pass the WAL "no PENDING entry" check before either commits, racing past the guard.
   *
   * The queue tail is replaced with a value-discarding chain so completed write results
   * don't accumulate in memory over a long session.
   *
   * If the service worker is killed mid-write, the queue resets on the next wake
   * (class fields re-initialise). WAL-guarded writes leave a PENDING entry that
   * applyPendingOperations detects at startup.
   *
   * @param {() => Promise<T>} fn - All registered inner methods return {success: false}
   *   rather than rejecting, so the circuit breaker inspects the return value to count
   *   failures. The catch branch handles unexpected rejections from non-standard callers.
   * @returns {Promise<T>} Rejects immediately if the circuit breaker is open.
   */
  #enqueue(fn) {
    if (this.#circuitOpen) {
      return Promise.reject(new Error(
        `IDB write queue halted after ${CIRCUIT_BREAKER_LIMIT} consecutive failures`
      ));
    }

    const taskPromise = this.#writeQueue.then(async () => {
      try {
        const taskResult = await fn();
        // Inner methods signal failure via {success: false} rather than rejecting.
        // Only reset the counter on an explicit success so repeated failures accumulate.
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

    // Detach queue advancement from taskPromise so a caller that never awaits
    // taskPromise does not stall subsequent writes.
    this.#writeQueue = taskPromise.then(
      () => undefined,
      () => undefined
    );

    return taskPromise;
  }

  /**
   * Returns the open IDB connection, opening one if it doesn't exist yet.
   * The #opening guard deduplicates concurrent open() calls at startup — without it,
   * two simultaneous callers would each get an independent connection with separate
   * versionchange subscriptions, making teardown unpredictable.
   *
   * onversionchange fires when another tab opens a higher DB version. We close
   * immediately — holding the connection blocks the other tab's upgrade transaction forever.
   *
   * @returns {Promise<IDBDatabase>}
   * @throws {Error} If the open fails or another tab is blocking the upgrade.
   */
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

  /**
   * Saves a report, evicting the oldest if the configured cap is reached.
   * Elements are stored in a separate store so listing reports never deserialises
   * the full element payload for every record.
   *
   * @param {Object} report - Must include `id`. Elements are split out automatically.
   * @returns {Promise<{success: boolean, id?: string, error?: string}>} Never throws.
   */
  saveReport(report) {
    return this.#enqueue(() => this.#saveReportInner(report));
  }

  /** Reads the maxReports config limit, splits elements from metadata, then delegates to #writeReportWithEviction. */
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

  /**
   * Counts existing reports and writes the new one atomically, deleting the oldest first
   * if the cap would be exceeded. Uses IDB event callbacks instead of async/await because
   * IDB auto-closes a transaction when the JS engine yields to async code — an await
   * between cursor steps would silently discard the write with no error.
   *
   * transactionToPromise is wired before any requests fire so the durability promise is
   * always established regardless of how quickly the callbacks execute.
   *
   * @param {IDBDatabase} db
   * @param {Object} meta - Report record without elements.
   * @param {Array|undefined} elements
   * @param {string} reportId
   * @param {number} maxReports
   * @returns {Promise<void>} Resolves when the write is durably on disk.
   */
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

  /**
   * Deletes the `excess` oldest reports by walking an ascending timestamp cursor,
   * then writes the new report — all inside the caller's already-open transaction
   * so the store never transiently exceeds the cap.
   *
   * @param {IDBObjectStore} reportStore
   * @param {IDBObjectStore} elementStore
   * @param {Object} reportCtx
   * @param {number} excess - How many records to delete before writing.
   */
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

  /**
   * Returns all saved reports ordered newest-first.
   * @returns {Promise<Object[]>} Empty array on read error.
   */
  async loadReports() {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_REPORTS, 'readonly');
      // 'prev' on the timestamp index returns records newest-first without a client-side sort.
      return collectCursor(tx.objectStore(STORE_REPORTS).index('by_timestamp'), 'prev');
    } catch (readError) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, readError.message);
      return [];
    }
  }

  /**
   * Returns the element payload for a single report. Elements are stored separately
   * from report metadata so that loading the report list stays cheap.
   *
   * @param {string} reportId
   * @returns {Promise<Object[]>} Empty array if not found or on error.
   */
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

  /**
   * Deletes a report and every comparison that references it in one atomic transaction.
   * Without atomicity a partial delete would leave orphaned diff and summary records,
   * wasting storage and breaking list queries.
   *
   * @param {string} id
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteReport(id) {
    return this.#enqueue(() => this.#deleteReportInner(id));
  }

  /** Collects all comparison IDs that reference the report, then deletes everything in one transaction. */
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

  /**
   * Finds all comparison IDs that reference a report as either the baseline or the compare side.
   * Both indexes are queried and deduplicated because a report can appear on either side of a pair.
   * Returns [] on error so the calling delete proceeds with best-effort cleanup.
   *
   * @param {IDBDatabase} db
   * @param {string} reportId
   * @returns {Promise<string[]>}
   */
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

  /**
   * Clears all user data stores in one atomic transaction.
   * The operation log (WAL) is excluded so write history is preserved for post-reset diagnostics.
   *
   * @returns {Promise<{success: boolean, error?: string}>}
   */
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
      // STORE_OP_LOG intentionally excluded — WAL history is kept for diagnostics.
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

  /**
   * Saves a comparison using a three-step write-ahead log (WAL) protocol designed to
   * survive a service worker kill mid-write: PENDING logged → data written → COMPLETE logged.
   * If the SW is killed between steps 1 and 2, the PENDING entry survives and is reported
   * at the next startup. Steps are serialised by #enqueue so concurrent calls are safe.
   *
   * @param {Object} meta - Must include `id` and `pairKey`.
   * @param {Array} slimResults
   * @returns {Promise<{success: boolean, id?: string, error?: string}>}
   */
  saveComparison(meta, slimResults) {
    return this.#enqueue(() => this.#saveComparisonInner(meta, slimResults));
  }

  /**
   * Executes the three WAL phases. Each phase uses its own separate transaction so a
   * data write failure leaves the PENDING entry durable and detectable on the next startup.
   * Full replay is not implemented — a PENDING entry after a successful data write is a
   * false-positive alarm, but the comparison data is intact, which is the acceptable trade-off.
   */
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

  /**
   * Checks for an existing comparison with the same pairKey and deletes it before writing.
   * The `by_pair` index is unique — a put() without the prior delete throws a ConstraintError
   * and aborts the transaction. The application-level delete also cleans up the associated
   * diffs and summary records, which IDB's constraint logic would not touch.
   *
   * @param {IDBDatabase} db
   * @param {Object} meta
   * @param {Array} slimResults
   * @returns {Promise<void>} Resolves when durably committed.
   */
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

  /**
   * Deletes the oldest comparisons if MAX_COMPARISONS would be exceeded, then writes
   * the new one — all inside the same transaction so the cap is never transiently exceeded.
   *
   * @param {{comp: IDBObjectStore, diffs: IDBObjectStore, summary: IDBObjectStore}} writeCtx
   * @param {Object} meta
   * @param {Array} slimResults
   */
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

  /**
   * Writes a PENDING entry to the operation log in its own separate transaction before
   * the data write starts. The separate transaction is critical: if the WAL write shared
   * the data transaction and both failed, there would be no PENDING entry to detect on
   * the next startup, making the interrupted write invisible to recovery.
   *
   * @param {IDBDatabase} db
   * @param {string} id - UUID linking this entry to its eventual COMPLETE update.
   * @param {string} operation
   * @param {Object} payload
   * @returns {Promise<void>}
   */
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

  /**
   * Updates a WAL entry's status to COMPLETE after the data write succeeds.
   * Re-reads the entry from the store before updating because IDB objects from a prior
   * transaction are snapshots — mutating the in-memory JS object has no effect on the store.
   *
   * @param {IDBDatabase} db
   * @param {string} id
   * @returns {Promise<void>}
   */
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

  /**
   * Scans the operation log for PENDING entries left by an interrupted write and reports
   * them via errorTracker. Called once at module load. Does not replay or repair writes —
   * replaying is unsafe because the eviction state may have changed since the interruption.
   *
   * @returns {Promise<void>} Never rejects; a scan failure is only logged, not surfaced.
   */
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

  /**
   * Looks up a saved comparison by its two report IDs and comparison mode.
   * @param {string} baselineId
   * @param {string} compareId
   * @param {string} mode
   * @returns {Promise<Object|null>} Null if not found or on error.
   */
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

  /**
   * Returns the diff results array for a comparison.
   * @param {string} comparisonId
   * @returns {Promise<Object[]>} Empty array if not found or on error.
   */
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

  /**
   * Saves a screenshot blob associated with a comparison.
   * @param {string} key - Stable content-addressable key for this blob.
   * @param {Blob} blob
   * @param {string} comparisonId
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveVisualBlob(key, blob, comparisonId) {
    return this.#enqueue(() => this.#saveVisualBlobInner(key, blob, comparisonId));
  }

  /** Performs the IDB write for a single visual blob. */
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

  /**
   * Returns a screenshot blob by its key.
   * @param {string} key
   * @returns {Promise<Blob|null>} Null if not found or on error.
   */
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

  /**
   * Deletes all screenshot blobs associated with a comparison.
   * @param {string} comparisonId
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteVisualBlobsByComparisonId(comparisonId) {
    return this.#enqueue(() => this.#deleteVisualBlobsInner(comparisonId));
  }

  /**
   * Reads blob keys in a readonly transaction first, then deletes them in a separate
   * readwrite transaction. This is safe because #enqueue guarantees no other write
   * interleaves between the two — without the queue, a concurrent blob write could
   * insert a key that the read missed, leaving it orphaned after the delete.
   *
   * @param {string} comparisonId
   * @returns {Promise<{success: boolean, error?: string}>}
   */
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

  /**
   * Saves a single visual diff keyframe. Prefer saveVisualKeyframe only for isolated
   * single-frame saves; use the batch equivalent if saving many frames in sequence
   * to avoid saturating the write queue.
   *
   * @param {Object} keyframe - Must include `id` and `sessionId`.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveVisualKeyframe(keyframe) {
    return this.#enqueue(() => this.#saveVisualKeyframeInner(keyframe));
  }

  /** Performs the IDB write for a single keyframe. */
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

  /**
   * Returns all keyframes for a session as a Map keyed by keyframe ID for O(1) lookup
   * in the visual diff renderer.
   *
   * @param {string} sessionId
   * @returns {Promise<Map<string, Object>>} Empty Map on error so the renderer degrades
   *   gracefully rather than crashing.
   */
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

  /**
   * Saves a single element bounding rect. For bulk saves during a capture session,
   * use saveVisualElementRects instead to avoid one queue entry per rect.
   *
   * @param {Object} rectRecord - Must include `sessionId`, `elementKey`, and `tabRole`.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveVisualElementRect(rectRecord) {
    return this.#enqueue(() => this.#saveVisualElementRectInner(rectRecord));
  }

  /** Performs the IDB write for a single element rect. */
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

  /**
   * Saves multiple element bounding rects in a single transaction. Prefer this over
   * repeated saveVisualElementRect calls during a capture session to avoid queuing
   * one write operation per rect.
   *
   * @param {Object[]} rectRecords - Each must include `sessionId`, `elementKey`, and `tabRole`.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveVisualElementRects(rectRecords) {
    return this.#enqueue(() => this.#saveVisualElementRectsInner(rectRecords));
  }

  /** Writes all rect records in one transaction. Returns early if the array is empty. */
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

  /**
   * Returns element bounding rects for a session, grouped by element key and tab role.
   * The outer Map key is `elementKey`; the inner object keys are tab role strings
   * ('baseline', 'compare'), giving the rect for each side of the comparison.
   *
   * @param {string} sessionId
   * @returns {Promise<Map<string, {[tabRole: string]: Object}>>}
   *   Empty Map on error so callers render without rect overlays rather than throwing.
   */
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

  /**
   * Deletes all blobs, keyframes, and element rects for a session in one atomic transaction.
   * Atomicity matters — leaving blobs without keyframes would break the visual diff display
   * with no clear error message to explain why.
   *
   * @param {string} sessionId
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteVisualDataBySession(sessionId) {
    return this.#enqueue(() => this.#deleteVisualDataBySessionInner(sessionId));
  }

  /**
   * Reads keys from three stores concurrently (safe — readonly transactions are
   * snapshot-isolated and carry no ordering requirement against each other), then
   * deletes across all three in one readwrite transaction.
   *
   * @param {string} sessionId
   * @returns {Promise<{success: boolean, error?: string}>}
   */
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

  /**
   * Returns all primary keys from a store matching an index value. Returns [] on any
   * error so bulk delete callers treat an unreadable store as empty rather than aborting
   * the whole delete operation over a non-critical key lookup.
   *
   * @param {IDBDatabase} db
   * @param {string} storeName
   * @param {string} indexName
   * @param {*} value
   * @returns {Promise<IDBValidKey[]>}
   */
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

  /**
   * Returns current IndexedDB storage usage for the extension origin.
   * Returns null (not a zero object) on error so callers can distinguish
   * "zero usage confirmed" from "check failed, no data available".
   * Returns a zero object when `navigator.storage.estimate` is unavailable
   * in the current context rather than letting the outer catch fire.
   *
   * @returns {Promise<{bytesInUse: number, quota: number, percentUsed: number, available: number}|null>}
   */
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

// All callers in this service worker must share this singleton — the write queue and
// circuit breaker are instance-local, so a second instance silently bypasses both.
const storage = new IDBRepository();
// Fire-and-forget: WAL scanning must not block the first user operation.
// The returned Promise is intentionally discarded; errors are handled internally.
storage.applyPendingOperations();
export default storage;