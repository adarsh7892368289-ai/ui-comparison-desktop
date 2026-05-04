'use strict';

const crypto = require('crypto');
const log = require('electron-log');

const playwrightManager = require('./playwright-manager');
const CH = require('./ipc-channels');

const _KNOWN_ERR_CODES = new Set([
  'CANCELLED', 'BROWSER_POLICY_BLOCKED', 'BROWSER_NOT_FOUND',
  'TIMEOUT', 'CSP_BLOCKED', 'INCOMPATIBLE_URLS', 'STORAGE_DEGRADED'
]);

function _classifyError(err) {
  const msg = (err?.message || String(err || '')).toLowerCase();
  const code = err?.code;
  if (typeof code === 'string' && _KNOWN_ERR_CODES.has(code)) {return code;}
  if (/cancelled/.test(msg)) {return 'CANCELLED';}
  if (/policy/i.test(msg) && /block/i.test(msg)) {return 'BROWSER_POLICY_BLOCKED';}
  if (/executable.*not.*found/i.test(msg) || /browser.*not.*installed/i.test(msg) || /unknown browsertype/i.test(msg)) {return 'BROWSER_NOT_FOUND';}
  if (/timeout/i.test(msg) || /timed out/i.test(msg)) {return 'TIMEOUT';}
  if (/content.security.policy/i.test(msg) || /\bcsp\b/i.test(msg) || /refused to (load|execute)/i.test(msg) || /addscripttag/i.test(msg)) {return 'CSP_BLOCKED';}
  if (/incompatible/i.test(msg)) {return 'INCOMPATIBLE_URLS';}
  return 'UNKNOWN';
}

function _sanitize(err) {
  const raw = err?.message || String(err || 'Unknown error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function _hostnameOf(url) {
  try {return new URL(url).hostname;} catch {return null;}
}

async function runBulkJob(jobSpec, pushEvent, isMasterCancelled, ctx) {
  const startedAt = Date.now();
  const {
    jobId,
    pairs,
    concurrency,
    hostCooldownMs,
    comparisonIdsByPairIndex
  } = jobSpec;

  const safeConcurrency = Math.max(1, Math.min(concurrency || 1, 8));
  const cooldownMs = Math.max(0, Number(hostCooldownMs) || 0);

  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(safeConcurrency);

  const hostLastDispatch = new Map();
  const pairOperationIds = new Map();
  const completedAck = new Set();

  ctx.setLimitInstance(limit);

  async function _hostGate(url) {
    const host = _hostnameOf(url);
    if (!host || cooldownMs === 0) {return;}
    let last = hostLastDispatch.get(host) ?? 0;
    let wait = Math.max(0, cooldownMs - (Date.now() - last));
    while (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
      last = hostLastDispatch.get(host) ?? 0;
      wait = Math.max(0, cooldownMs - (Date.now() - last));
    }
    hostLastDispatch.set(host, Date.now());
  }

  function _isOpCancelled(opId) {
    return !!ctx.cancelRegistry.get(opId)?.cancelled;
  }

  async function _runPair(pair) {
    const { pairIndex } = pair;

    if (isMasterCancelled()) {
      pushEvent(CH.BULK_PAIR_COMPLETED, {
        jobId, pairIndex, status: 'cancelled'
      });
      return { pairIndex, status: 'cancelled' };
    }

    const operationId = crypto.randomUUID();
    const opIdBaseline = crypto.randomUUID();
    const opIdCompare = crypto.randomUUID();
    pairOperationIds.set(pairIndex, operationId);
    ctx.registerOp(operationId, 'bulk-pair');
    ctx.registerOp(opIdBaseline, 'bulk-extract');
    ctx.registerOp(opIdCompare, 'bulk-extract');
    ctx.addJobOpId(jobId, operationId);
    ctx.addJobOpId(jobId, opIdBaseline);
    ctx.addJobOpId(jobId, opIdCompare);

    let baselineOuter = 0;
    let compareOuter = 0;

    const pushPairProgress = (phase, label, pct) => {
      pushEvent(CH.BULK_PROGRESS, {
        jobId, pairIndex, phase, label: label ?? null, pct, operationId
      });
    };

    try {
      pushPairProgress('extracting-baseline', 'Starting…', 0);

      const baselineHas = pair.dedupedSides?.baseline;
      const compareHas = pair.dedupedSides?.compare;

      const browser = pair.browser || { browserType: 'chromium', channel: null, executablePath: null };

      const _filtersForPair = (() => {
        const f = {};
        if (pair.filterClass) {f.class = pair.filterClass;}
        if (pair.filterId)    {f.id    = pair.filterId;}
        if (pair.filterTag)   {f.tag   = pair.filterTag;}
        return Object.keys(f).length > 0 ? f : null;
      })();

      let baselineResult, compareResult;

      const _awaitProvided = (side) => {
        if (typeof ctx.awaitProvidedElements !== 'function') {
          return Promise.reject(Object.assign(
            new Error('Renderer did not provide deduped elements'),
            { code: 'STORAGE_DEGRADED' }
          ));
        }
        return ctx.awaitProvidedElements(pairIndex, side, 10_000);
      };

      const runBaseline = baselineHas
        ? (async () => {
            baselineOuter = 25;
            pushPairProgress('extracting-baseline', 'Reused recent extraction', 25);
            const elements = await _awaitProvided('baseline');
            return { reused: true, reportId: baselineHas.reportId, elements };
          })()
        : (async () => {
            await _hostGate(pair.baselineUrl);
            return playwrightManager.runExtraction({
              url: pair.baselineUrl,
              browser,
              filters: _filtersForPair,
              onProgress: (label, innerPct) => {
                baselineOuter = (innerPct * 25) / 100;
                const pct = Math.max(baselineOuter, compareOuter);
                pushPairProgress('extracting-baseline', label, pct);
              },
              isCancelled: () => _isOpCancelled(opIdBaseline) || _isOpCancelled(operationId) || isMasterCancelled()
            });
          })();

      const runCompare = compareHas
        ? (async () => {
            compareOuter = 25;
            pushPairProgress('extracting-compare', 'Reused recent extraction', 25);
            const elements = await _awaitProvided('compare');
            return { reused: true, reportId: compareHas.reportId, elements };
          })()
        : (async () => {
            await _hostGate(pair.compareUrl);
            return playwrightManager.runExtraction({
              url: pair.compareUrl,
              browser,
              filters: _filtersForPair,
              onProgress: (label, innerPct) => {
                compareOuter = (innerPct * 25) / 100;
                const pct = Math.max(baselineOuter, compareOuter);
                pushPairProgress('extracting-compare', label, pct);
              },
              isCancelled: () => _isOpCancelled(opIdCompare) || _isOpCancelled(operationId) || isMasterCancelled()
            });
          })();

      [baselineResult, compareResult] = await Promise.allSettled([runBaseline, runCompare]);

      if (baselineResult.status === 'rejected' || compareResult.status === 'rejected') {
        const failedSide = baselineResult.status === 'rejected' ? baselineResult.reason : compareResult.reason;
        const errorCode = _classifyError(failedSide);
        const status = errorCode === 'CANCELLED' ? 'cancelled' : 'failed';
        pushEvent(CH.BULK_PAIR_COMPLETED, {
          jobId, pairIndex, status,
          error: _sanitize(failedSide),
          errorCode
        });
        return { pairIndex, status, errorCode };
      }

      pushPairProgress('matching', 'Comparing elements…', 50);

      if (isMasterCancelled() || _isOpCancelled(operationId)) {
        pushEvent(CH.BULK_PAIR_COMPLETED, { jobId, pairIndex, status: 'cancelled' });
        return { pairIndex, status: 'cancelled' };
      }

      const baselineVal = baselineResult.value;
      const compareVal = compareResult.value;
      const baselineElements = baselineVal?.elements || [];
      const compareElements = compareVal?.elements || [];

      let comparisonResult;
      try {
        comparisonResult = await playwrightManager.runComparison({
          comparisonId: comparisonIdsByPairIndex?.[pairIndex],
          baselineId: baselineVal?.reportId ?? baselineVal?.id ?? null,
          compareId:  compareVal?.reportId  ?? compareVal?.id  ?? null,
          mode: pair.mode,
          baselineUrl: pair.baselineUrl,
          compareUrl: pair.compareUrl,
          baselineElements,
          compareElements,
          includeScreenshots: !!pair.includeScreenshots,
          browser,
          blobCache: ctx.blobCache,
          isCancelled: () => _isOpCancelled(operationId) || isMasterCancelled(),
          onProgress: (label, innerPct) => {
            let outerPct;
            if (innerPct <= 80) {
              const t = Math.max(0, Math.min(1, (innerPct - 5) / (80 - 5)));
              outerPct = 50 + t * 30;
            } else {
              const t = Math.max(0, Math.min(1, (innerPct - 80) / 20));
              outerPct = 80 + t * 15;
            }
            const phase = innerPct >= 80 ? 'screenshots' : 'matching';
            pushPairProgress(phase, label, outerPct);
          }
        });
      } catch (err) {
        const errorCode = _classifyError(err);
        const status = errorCode === 'CANCELLED' ? 'cancelled' : 'failed';
        pushEvent(CH.BULK_PAIR_COMPLETED, {
          jobId, pairIndex, status,
          error: _sanitize(err),
          errorCode
        });
        return { pairIndex, status, errorCode };
      }

      completedAck.add(pairIndex);
      const dedupSide = (baselineVal?.reused && compareVal?.reused) ? 'both'
        : baselineVal?.reused ? 'baseline'
        : compareVal?.reused ? 'compare'
        : 'none';
      pushEvent(CH.BULK_PAIR_COMPLETED, {
        jobId, pairIndex, status: 'done',
        baselineReport: baselineVal,
        compareReport: compareVal,
        comparisonResult,
        deduped: dedupSide
      });
      return { pairIndex, status: 'done', deduped: dedupSide };
    } catch (err) {
      const errorCode = _classifyError(err);
      const status = errorCode === 'CANCELLED' ? 'cancelled' : 'failed';
      pushEvent(CH.BULK_PAIR_COMPLETED, {
        jobId, pairIndex, status,
        error: _sanitize(err),
        errorCode
      });
      return { pairIndex, status, errorCode };
    } finally {
      ctx.unregisterOp(operationId);
      ctx.unregisterOp(opIdBaseline);
      ctx.unregisterOp(opIdCompare);
      pairOperationIds.delete(pairIndex);
    }
  }

  const pairSettlers = new Map();
  if (typeof ctx.setPairSettlers === 'function') {
    ctx.setPairSettlers(pairSettlers);
  }

  const slotPromises = pairs.map((pair) => {
    let resolveOuter;
    const outer = new Promise((resolve) => { resolveOuter = resolve; });
    const settler = {
      started: false,
      settled: false,
      settle(value) {
        if (this.settled) {return;}
        this.settled = true;
        resolveOuter(value);
      }
    };
    pairSettlers.set(pair.pairIndex, settler);

    limit(async () => {
      settler.started = true;
      if (settler.settled) {return;}
      if (isMasterCancelled()) {
        pushEvent(CH.BULK_PAIR_COMPLETED, { jobId, pairIndex: pair.pairIndex, status: 'cancelled' });
        settler.settle({ pairIndex: pair.pairIndex, status: 'cancelled' });
        return;
      }
      try {
        const result = await _runPair(pair);
        settler.settle(result);
      } catch (err) {
        const errorCode = _classifyError(err);
        if (errorCode === 'CANCELLED' || /AbortError/i.test(err?.name || '')) {
          pushEvent(CH.BULK_PAIR_COMPLETED, { jobId, pairIndex: pair.pairIndex, status: 'cancelled' });
          settler.settle({ pairIndex: pair.pairIndex, status: 'cancelled' });
          return;
        }
        log.error('[BulkRunner] unexpected pair error', { jobId, pairIndex: pair.pairIndex, err: err?.message });
        pushEvent(CH.BULK_PAIR_COMPLETED, {
          jobId, pairIndex: pair.pairIndex, status: 'failed',
          error: _sanitize(err), errorCode
        });
        settler.settle({ pairIndex: pair.pairIndex, status: 'failed', errorCode });
      }
    });

    return outer;
  });

  const results = await Promise.all(slotPromises);

  const summary = {
    total: results.length,
    succeeded: results.filter((r) => r?.status === 'done').length,
    failed: results.filter((r) => r?.status === 'failed').length,
    cancelled: results.filter((r) => r?.status === 'cancelled').length,
    deduped: results.filter((r) => r?.deduped && r.deduped !== 'none').length
  };

  pushEvent(CH.BULK_JOB_COMPLETE, {
    jobId,
    summary,
    durationMs: Date.now() - startedAt
  });

  ctx.cleanupJob(jobId);
  return { summary };
}

module.exports = { runBulkJob };
