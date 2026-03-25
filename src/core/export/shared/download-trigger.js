/**
 * Triggers a browser file download by creating a temporary object URL and a hidden <a> element.
 * Runs in the popup context — requires access to document.body and URL.createObjectURL.
 * Called by: csv-exporter.js, json-exporter.js. Excel uses XLSX.writeFile directly.
 */

/**
 * Delay before revoking the object URL. Long enough for the browser's download
 * manager to read the URL but short enough not to leak the blob in memory.
 */
const URL_REVOKE_DELAY_MS = 1_000;

/**
 * Creates a Blob from `content`, attaches it to a temporary anchor, clicks it to
 * start the download, and revokes the object URL after a short delay.
 * The anchor is appended to and removed from document.body synchronously around
 * the click — some browsers silently drop the download if the anchor is detached.
 */
function triggerDownload(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), URL_REVOKE_DELAY_MS);
}

export { triggerDownload };