'use strict';

const { protocol, net } = require('electron');
const path = require('path');
const log  = require('electron-log');

const blobCache = new Map();

function resolveStaticPath(pathname) {
  const clean = pathname.replace(/^\/\.\//, '/').replace(/^\//, '');
  return path.join(__dirname, '../renderer', clean || 'index.html');
}

function registerProtocolHandler() {
  protocol.handle('app', async (request) => {
    const url      = new URL(request.url);
    const pathname = url.pathname;

    if (pathname.startsWith('/blob/') || pathname.startsWith('/./blob/')) {
      const blobId = pathname.replace(/^\/(\.\/)?blob\//, '');
      const entry  = blobCache.get(blobId);

      if (!entry) {
        log.warn('Protocol handler: blob not found in cache', { blobId });
        return new Response('Blob not found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      return new Response(entry.buffer, {
        status:  200,
        headers: {
          'Content-Type':  entry.mimeType,
          'Cache-Control': 'private, max-age=3600',
          'Content-Length': String(entry.buffer.length),
        },
      });
    }

    const filePath   = resolveStaticPath(pathname);
    const fileUrl    = `file://${filePath.replace(/\\/g, '/')}`;

    try {
      return await net.fetch(fileUrl);
    } catch (err) {
      log.error('Protocol handler: static file not found', { pathname, filePath, error: err.message });
      return new Response(`File not found: ${pathname}`, {
        status:  404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  });

  log.info('Protocol handler registered for app:// scheme');
}

module.exports = { registerProtocolHandler, blobCache };