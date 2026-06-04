import { describe, it, expect, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

const DB_NAME = 'ui_comparison_db_test';

function buildReportStores(db) {
  const reportStore = db.createObjectStore('reports', { keyPath: 'id' });
  reportStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  reportStore.createIndex('by_url', 'url', { unique: false });
  reportStore.createIndex('by_url_ts', ['url', 'timestamp'], { unique: false });
  db.createObjectStore('elements', { keyPath: 'reportId' });
}

function buildComparisonStores(db) {
  const compStore = db.createObjectStore('comparisons', { keyPath: 'id' });
  compStore.createIndex('by_pair', 'pairKey', { unique: true });
  compStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  compStore.createIndex('by_baseline', 'baselineId', { unique: false });
  compStore.createIndex('by_compare', 'compareId', { unique: false });
  db.createObjectStore('comparison_diffs', { keyPath: 'comparisonId' });
}

function buildAuxStores(db) {
  if (!db.objectStoreNames.contains('comparison_summary')) {
    const summaryStore = db.createObjectStore('comparison_summary', { keyPath: 'comparisonId' });
    summaryStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  }
  if (!db.objectStoreNames.contains('visual_blobs')) {
    const blobStore = db.createObjectStore('visual_blobs', { keyPath: 'key' });
    blobStore.createIndex('by_comparisonId', 'comparisonId', { unique: false });
    blobStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  }
  if (!db.objectStoreNames.contains('operation_log')) {
    const logStore = db.createObjectStore('operation_log', { keyPath: 'id' });
    logStore.createIndex('by_status', 'status', { unique: false });
    logStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  }
}

function upgradeToV6(db) {
  const kfStore = db.createObjectStore('visual_keyframes', { keyPath: 'id' });
  kfStore.createIndex('by_session', 'sessionId', { unique: false });
  const rectStore = db.createObjectStore('visual_element_rects', { keyPath: 'id' });
  rectStore.createIndex('by_session', 'sessionId', { unique: false });
  rectStore.createIndex('by_session_element', ['sessionId', 'elementKey'], { unique: false });
}

function upgradeToV8(db) {
  if (!db.objectStoreNames.contains('app_meta')) {
    db.createObjectStore('app_meta', { keyPath: 'key' });
  }
}

function upgradeToV9(db, upgradeTx) {
  if (!db.objectStoreNames.contains('bulk_jobs')) {
    const jobsStore = db.createObjectStore('bulk_jobs', { keyPath: 'id' });
    jobsStore.createIndex('by_createdAt', 'createdAt', { unique: false });
    jobsStore.createIndex('by_status', 'status', { unique: false });
  }
  if (!db.objectStoreNames.contains('bulk_pairs')) {
    const pairsStore = db.createObjectStore('bulk_pairs', { keyPath: 'id' });
    pairsStore.createIndex('by_jobId', 'jobId', { unique: false });
    pairsStore.createIndex('by_jobId_status', ['jobId', 'status'], { unique: false });
    pairsStore.createIndex('by_jobId_pairIndex', ['jobId', 'pairIndex'], { unique: false });
  }
  if (db.objectStoreNames.contains('reports')) {
    const reportStore = upgradeTx.objectStore('reports');
    if (!reportStore.indexNames.contains('by_bulkJobId')) {
      reportStore.createIndex('by_bulkJobId', 'bulkJobId', { unique: false });
    }
    if (!reportStore.indexNames.contains('by_extractionKey')) {
      reportStore.createIndex('by_extractionKey', 'extractionKey', { unique: false });
    }
  }
  if (db.objectStoreNames.contains('comparisons')) {
    const compStore = upgradeTx.objectStore('comparisons');
    if (!compStore.indexNames.contains('by_bulkJobId')) {
      compStore.createIndex('by_bulkJobId', 'bulkJobId', { unique: false });
    }
  }
}

function upgradeToV10(db) {
  if (!db.objectStoreNames.contains('sauce_jobs')) {
    const store = db.createObjectStore('sauce_jobs', { keyPath: 'id' });
    store.createIndex('by_status', 'status', { unique: false });
    store.createIndex('by_createdAt', 'createdAt', { unique: false });
  }
}

function upgradeToV11(db) {
  if (!db.objectStoreNames.contains('app_settings')) {
    db.createObjectStore('app_settings', { keyPath: 'key' });
  }
}

function upgradeToV12(db, upgradeTx) {
  if (!db.objectStoreNames.contains('report_visual_manifests')) {
    db.createObjectStore('report_visual_manifests', { keyPath: 'reportId' });
  }
  if (db.objectStoreNames.contains('visual_blobs')) {
    const blobStore = upgradeTx.objectStore('visual_blobs');
    if (!blobStore.indexNames.contains('by_reportId')) {
      blobStore.createIndex('by_reportId', 'reportId', { unique: false });
    }
  }
}

function openDbAtVersion(version, onUpgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = (event) => {
      onUpgrade(event.target.result, event.target.transaction, event.oldVersion);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

describe('IDB Schema Upgrade v9 → v10', () => {
  afterEach(async () => {
    await deleteDb();
  });

  it('creates sauce_jobs store with both indexes after v10 upgrade', async () => {

    const dbV9 = await openDbAtVersion(9, (db, tx, oldVersion) => {
      if (oldVersion < 1) buildReportStores(db);
      if (oldVersion < 2) buildComparisonStores(db);
      if (oldVersion < 4) buildAuxStores(db);
      if (oldVersion < 6) upgradeToV6(db);
      if (oldVersion < 8) upgradeToV8(db);
      if (oldVersion < 9) upgradeToV9(db, tx);
    });
    dbV9.close();


    const dbV10 = await openDbAtVersion(10, (db, tx, oldVersion) => {
      if (oldVersion < 10) upgradeToV10(db);
    });

    expect(dbV10.objectStoreNames.contains('sauce_jobs')).toBe(true);

    const tx = dbV10.transaction('sauce_jobs', 'readonly');
    const store = tx.objectStore('sauce_jobs');
    expect(store.indexNames.contains('by_status')).toBe(true);
    expect(store.indexNames.contains('by_createdAt')).toBe(true);
    expect(store.keyPath).toBe('id');

    dbV10.close();
  });

  it('preserves all existing v9 stores after v10 upgrade', async () => {
    const dbV9 = await openDbAtVersion(9, (db, tx, oldVersion) => {
      if (oldVersion < 1) buildReportStores(db);
      if (oldVersion < 2) buildComparisonStores(db);
      if (oldVersion < 4) buildAuxStores(db);
      if (oldVersion < 6) upgradeToV6(db);
      if (oldVersion < 8) upgradeToV8(db);
      if (oldVersion < 9) upgradeToV9(db, tx);
    });
    dbV9.close();

    const dbV10 = await openDbAtVersion(10, (db, tx, oldVersion) => {
      if (oldVersion < 10) upgradeToV10(db);
    });

    const expectedStores = [
    'reports', 'elements', 'comparisons', 'comparison_diffs',
    'comparison_summary', 'visual_blobs', 'operation_log',
    'visual_keyframes', 'visual_element_rects', 'app_meta',
    'bulk_jobs', 'bulk_pairs', 'sauce_jobs'];


    for (const storeName of expectedStores) {
      expect(dbV10.objectStoreNames.contains(storeName)).toBe(true);
    }

    dbV10.close();
  });

  it('preserves existing data in v9 stores after v10 upgrade', async () => {

    const dbV9 = await openDbAtVersion(9, (db, tx, oldVersion) => {
      if (oldVersion < 1) buildReportStores(db);
      if (oldVersion < 2) buildComparisonStores(db);
      if (oldVersion < 4) buildAuxStores(db);
      if (oldVersion < 6) upgradeToV6(db);
      if (oldVersion < 8) upgradeToV8(db);
      if (oldVersion < 9) upgradeToV9(db, tx);
    });


    const reportTx = dbV9.transaction(['reports', 'elements', 'bulk_jobs'], 'readwrite');
    reportTx.objectStore('reports').put({
      id: 'report-1',
      url: 'https://example.com',
      timestamp: '2026-01-01T00:00:00Z',
      totalElements: 42
    });
    reportTx.objectStore('elements').put({
      reportId: 'report-1',
      data: [{ hpid: 'el1', tag: 'DIV' }]
    });
    reportTx.objectStore('bulk_jobs').put({
      id: 'bulk-1',
      status: 'completed',
      createdAt: Date.now()
    });
    await new Promise((resolve, reject) => {
      reportTx.oncomplete = resolve;
      reportTx.onerror = () => reject(reportTx.error);
    });

    dbV9.close();


    const dbV10 = await openDbAtVersion(10, (db, tx, oldVersion) => {
      if (oldVersion < 10) upgradeToV10(db);
    });


    const readTx = dbV10.transaction(['reports', 'elements', 'bulk_jobs'], 'readonly');

    const report = await new Promise((resolve) => {
      const req = readTx.objectStore('reports').get('report-1');
      req.onsuccess = () => resolve(req.result);
    });
    expect(report).not.toBeNull();
    expect(report.url).toBe('https://example.com');
    expect(report.totalElements).toBe(42);

    const elements = await new Promise((resolve) => {
      const req = readTx.objectStore('elements').get('report-1');
      req.onsuccess = () => resolve(req.result);
    });
    expect(elements).not.toBeNull();
    expect(elements.data).toHaveLength(1);
    expect(elements.data[0].hpid).toBe('el1');

    const bulkJob = await new Promise((resolve) => {
      const req = readTx.objectStore('bulk_jobs').get('bulk-1');
      req.onsuccess = () => resolve(req.result);
    });
    expect(bulkJob).not.toBeNull();
    expect(bulkJob.status).toBe('completed');

    dbV10.close();
  });

  it('sauce_jobs store can be written to and read from after upgrade', async () => {
    const dbV10 = await openDbAtVersion(10, (db, tx, oldVersion) => {
      if (oldVersion < 1) buildReportStores(db);
      if (oldVersion < 2) buildComparisonStores(db);
      if (oldVersion < 4) buildAuxStores(db);
      if (oldVersion < 6) upgradeToV6(db);
      if (oldVersion < 8) upgradeToV8(db);
      if (oldVersion < 9) upgradeToV9(db, tx);
      if (oldVersion < 10) upgradeToV10(db);
    });

    const writeTx = dbV10.transaction('sauce_jobs', 'readwrite');
    writeTx.objectStore('sauce_jobs').put({
      id: 'sauce-job-1',
      status: 'submitted',
      baselineStatus: 'submitted',
      compareStatus: 'submitted',
      createdAt: Date.now(),
      baselineUrl: 'https://a.com',
      compareUrl: 'https://b.com',
      platform: 'Windows 11',
      browserName: 'chromium'
    });
    await new Promise((resolve, reject) => {
      writeTx.oncomplete = resolve;
      writeTx.onerror = () => reject(writeTx.error);
    });


    const readTx = dbV10.transaction('sauce_jobs', 'readonly');
    const statusIdx = readTx.objectStore('sauce_jobs').index('by_status');
    const results = await new Promise((resolve) => {
      const req = statusIdx.getAll(IDBKeyRange.only('submitted'));
      req.onsuccess = () => resolve(req.result);
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('sauce-job-1');
    expect(results[0].platform).toBe('Windows 11');


    const createdIdx = readTx.objectStore('sauce_jobs').index('by_createdAt');
    const allByDate = await new Promise((resolve) => {
      const req = createdIdx.getAll();
      req.onsuccess = () => resolve(req.result);
    });
    expect(allByDate).toHaveLength(1);

    dbV10.close();
  });

  it('upgradeToV10 is idempotent — guarded by objectStoreNames.contains', async () => {
    const dbV10 = await openDbAtVersion(10, (db, tx, oldVersion) => {
      if (oldVersion < 1) buildReportStores(db);
      if (oldVersion < 2) buildComparisonStores(db);
      if (oldVersion < 4) buildAuxStores(db);
      if (oldVersion < 6) upgradeToV6(db);
      if (oldVersion < 8) upgradeToV8(db);
      if (oldVersion < 9) upgradeToV9(db, tx);

      upgradeToV10(db);
      upgradeToV10(db);
    });

    expect(dbV10.objectStoreNames.contains('sauce_jobs')).toBe(true);
    dbV10.close();
  });
});

describe('IDB Schema Upgrade v11 → v12', () => {
  afterEach(async () => {
    await deleteDb();
  });

  function openV11(extra) {
    return openDbAtVersion(11, (db, tx, oldVersion) => {
      if (oldVersion < 1) buildReportStores(db);
      if (oldVersion < 2) buildComparisonStores(db);
      if (oldVersion < 4) buildAuxStores(db);
      if (oldVersion < 6) upgradeToV6(db);
      if (oldVersion < 8) upgradeToV8(db);
      if (oldVersion < 9) upgradeToV9(db, tx);
      if (oldVersion < 10) upgradeToV10(db);
      if (oldVersion < 11) upgradeToV11(db);
      if (extra) extra(db, tx, oldVersion);
    });
  }

  it('creates report_visual_manifests store and visual_blobs by_reportId index after v12', async () => {
    const dbV11 = await openV11();
    dbV11.close();

    const dbV12 = await openDbAtVersion(12, (db, tx, oldVersion) => {
      if (oldVersion < 12) upgradeToV12(db, tx);
    });

    expect(dbV12.objectStoreNames.contains('report_visual_manifests')).toBe(true);
    const manifestStore = dbV12.transaction('report_visual_manifests', 'readonly').objectStore('report_visual_manifests');
    expect(manifestStore.keyPath).toBe('reportId');

    const blobStore = dbV12.transaction('visual_blobs', 'readonly').objectStore('visual_blobs');
    expect(blobStore.indexNames.contains('by_reportId')).toBe(true);
    dbV12.close();
  });

  it('preserves existing reports and comparison_summary data after v12 upgrade', async () => {
    const dbV11 = await openV11();
    const tx = dbV11.transaction('reports', 'readwrite');
    tx.objectStore('reports').put({ id: 'r-1', url: 'https://x.com', timestamp: '2026-01-01T00:00:00Z', totalElements: 7 });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    dbV11.close();

    const dbV12 = await openDbAtVersion(12, (db, t, oldVersion) => {
      if (oldVersion < 12) upgradeToV12(db, t);
    });
    const report = await new Promise((resolve) => {
      const req = dbV12.transaction('reports', 'readonly').objectStore('reports').get('r-1');
      req.onsuccess = () => resolve(req.result);
    });
    expect(report).not.toBeNull();
    expect(report.totalElements).toBe(7);
    dbV12.close();
  });

  it('report_visual_manifests round-trips a manifest and blobs query by reportId', async () => {
    const dbV12 = await openDbAtVersion(12, (db, tx, oldVersion) => {
      if (oldVersion < 1) buildReportStores(db);
      if (oldVersion < 2) buildComparisonStores(db);
      if (oldVersion < 4) buildAuxStores(db);
      if (oldVersion < 6) upgradeToV6(db);
      if (oldVersion < 8) upgradeToV8(db);
      if (oldVersion < 9) upgradeToV9(db, tx);
      if (oldVersion < 10) upgradeToV10(db);
      if (oldVersion < 11) upgradeToV11(db);
      if (oldVersion < 12) upgradeToV12(db, tx);
    });

    const writeTx = dbV12.transaction(['report_visual_manifests', 'visual_blobs'], 'readwrite');
    writeTx.objectStore('report_visual_manifests').put({
      reportId: 'rep-9', manifest: { keyframes: [{ id: 'kf_0' }], elementKeyframeMap: { 'el.1': 'kf_0' } }
    });
    writeTx.objectStore('visual_blobs').put({ key: 'report:rep-9:kf_0', blob: 'data', reportId: 'rep-9', timestamp: 't' });
    await new Promise((resolve, reject) => { writeTx.oncomplete = resolve; writeTx.onerror = () => reject(writeTx.error); });

    const manifest = await new Promise((resolve) => {
      const req = dbV12.transaction('report_visual_manifests', 'readonly').objectStore('report_visual_manifests').get('rep-9');
      req.onsuccess = () => resolve(req.result);
    });
    expect(manifest.manifest.keyframes[0].id).toBe('kf_0');

    const blobs = await new Promise((resolve) => {
      const req = dbV12.transaction('visual_blobs', 'readonly').objectStore('visual_blobs').index('by_reportId').getAll(IDBKeyRange.only('rep-9'));
      req.onsuccess = () => resolve(req.result);
    });
    expect(blobs).toHaveLength(1);
    expect(blobs[0].key).toBe('report:rep-9:kf_0');
    dbV12.close();
  });
});