'use strict';

const { protocol, net } = require('electron');
const path = require('path');
const log = require('electron-log');

const MAX_BLOB_CACHE_BYTES = 512 * 1024 * 1024;

let _cacheTotalBytes = 0;
const blobCache = new Map();

function _comparisonIdFromKey(key) {
  const sep = key.indexOf(':');
  return sep === -1 ? key : key.slice(0, sep);
}

function _evictOldestComparisonGroup(activeComparisonId) {
  let targetId = null;
  for (const key of blobCache.keys()) {
    const candidate = _comparisonIdFromKey(key);
    if (candidate === activeComparisonId) {continue;}
    targetId = candidate;
    break;
  }

  if (!targetId) {return false;}

  let freedBytes = 0;
  for (const [key, entry] of blobCache) {
    if (_comparisonIdFromKey(key) === targetId) {
      freedBytes += entry.buffer.byteLength;
      blobCache.delete(key);
    }
  }

  _cacheTotalBytes -= freedBytes;
  if (_cacheTotalBytes < 0) {_cacheTotalBytes = 0;}

  log.warn('[Protocol] BlobCache eviction triggered', { evictedComparisonId: targetId, freedBytes });
  return true;
}

function blobCacheSet(blobId, entry) {
  const incoming = entry.buffer.byteLength;

  if (incoming > MAX_BLOB_CACHE_BYTES) {
    log.warn('[Protocol] Single blob exceeds cache budget — not stored', { blobId, bytes: incoming });
    return;
  }

  const activeComparisonId = _comparisonIdFromKey(blobId);

  while (_cacheTotalBytes + incoming > MAX_BLOB_CACHE_BYTES && blobCache.size > 0) {
    const evicted = _evictOldestComparisonGroup(activeComparisonId);
    if (!evicted) {
      log.warn('[Protocol] Cache cap reached but only the active comparison is present — refusing to self-evict', {
        activeComparisonId,
        bytesUsed: _cacheTotalBytes,
        incoming,
        cap: MAX_BLOB_CACHE_BYTES
      });
      break;
    }
  }

  blobCache.set(blobId, entry);
  _cacheTotalBytes += incoming;
}

function blobCacheDelete(key) {
  const entry = blobCache.get(key);
  if (entry) {
    _cacheTotalBytes -= entry.buffer.byteLength;
    if (_cacheTotalBytes < 0) {_cacheTotalBytes = 0;}
    blobCache.delete(key);
  }
}

const { pathToFileURL } = require('url');
const distRoot = path.join(__dirname, 'renderer');

function registerProtocolHandler() {
  protocol.handle('app', (request) => {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith('/blob/')) {
        const blobId = decodeURIComponent(url.pathname.slice('/blob/'.length));
        const entry = blobCache.get(blobId);

        if (!entry) {
          log.warn('[Protocol] Blob not found in cache', { blobId });
          return new Response('Blob not found', { status: 404 });
        }

        return new Response(entry.buffer, {
          status: 200,
          headers: {
            'Content-Type': entry.mimeType ?? 'image/webp',
            'Cache-Control': 'no-store'
          }
        });
      }

      const relativePath = url.pathname === '/' ? 'index.html' : url.pathname;
      const absolutePath = path.join(distRoot, relativePath);

      if (!absolutePath.startsWith(distRoot)) {
        log.warn('[Protocol] Path traversal attempt blocked', { relativePath });
        return new Response('Forbidden', { status: 403 });
      }

      return net.fetch(pathToFileURL(absolutePath).href);

    } catch (err) {
      log.error('[Protocol] Handler threw', { error: err.message, url: request.url });
      return new Response('Internal error', { status: 500 });
    }
  });

  log.info('[Protocol] app:// scheme handler registered', { distRoot });
}

module.exports = { registerProtocolHandler, blobCache, blobCacheSet, blobCacheDelete };