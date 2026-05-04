'use strict';

function todayYmd() {
  const now   = new Date();
  const year  = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day   = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function _bytesToHex(buffer) {
  const view = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    const byte = view[i];
    out += (byte < 16 ? '0' : '') + byte.toString(16);
  }
  return out;
}

async function _sha256Hex(input) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('SubtleCrypto digest unavailable in this runtime');
  }
  const data   = new TextEncoder().encode(input);
  const buffer = await subtle.digest('SHA-256', data);
  return _bytesToHex(buffer);
}

function _channelOrPath(browser) {
  if (!browser || typeof browser !== 'object') { return 'managed'; }
  return browser.channel ?? browser.executablePath ?? 'managed';
}

async function buildExtractionKey({ url, browserType, channel, executablePath, dateYmd }) {
  const channelOrPath = channel ?? executablePath ?? 'managed';
  const day           = dateYmd ?? todayYmd();
  const input         = `${url}|${browserType}|${channelOrPath}|${day}`;
  return _sha256Hex(input);
}

async function computeExtractionKey(url, browserDescriptor) {
  const browserType = browserDescriptor?.browserType ?? 'chromium';
  const channelOrPath = _channelOrPath(browserDescriptor);
  const day = todayYmd();
  const input = `${url}|${browserType}|${channelOrPath}|${day}`;
  return _sha256Hex(input);
}

module.exports = { todayYmd, buildExtractionKey, computeExtractionKey };
