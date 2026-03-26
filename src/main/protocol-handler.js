'use strict';

const { protocol, net } = require('electron');
const path = require('path');
const log  = require('electron-log');

const blobCache = new Map();

const DIST_ROOT = path.resolve(__dirname, '../renderer');

function registerProtocolHandler() {
  protocol.handle('app', (request) => {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith('/blob/')) {
        const blobId = decodeURIComponent(url.pathname.slice('/blob/'.length));
        const entry  = blobCache.get(blobId);

        if (!entry) {
          log.warn('[Protocol] Blob not found in cache', { blobId });
          return new Response('Blob not found', { status: 404 });
        }

        return new Response(entry.buffer, {
          status: 200,
          headers: {
            'Content-Type':  entry.mimeType ?? 'image/webp',
            'Cache-Control': 'no-store',
          },
        });
      }

      const relativePath = url.pathname === '/' ? 'index.html' : url.pathname;
      const absolutePath = path.join(DIST_ROOT, relativePath);

      if (!absolutePath.startsWith(DIST_ROOT)) {
        log.warn('[Protocol] Path traversal attempt blocked', { relativePath });
        return new Response('Forbidden', { status: 403 });
      }

      return net.fetch(`file://${absolutePath}`);

    } catch (err) {
      log.error('[Protocol] Handler threw', { error: err.message, url: request.url });
      return new Response('Internal error', { status: 500 });
    }
  });

  log.info('[Protocol] app:// scheme handler registered', { distRoot: DIST_ROOT });
}

module.exports = { registerProtocolHandler, blobCache };