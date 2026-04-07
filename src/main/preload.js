'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const CH = require('./ipc-channels');

function makePushBridge(channel) {
  return (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {

  startComparison: (params) =>
    ipcRenderer.invoke(CH.START_COMPARISON, params),

  onComparisonProgress: makePushBridge(CH.COMPARISON_PROGRESS),

  extractElements: (params) =>
    ipcRenderer.invoke(CH.EXTRACT_ELEMENTS, params),

  onExtractionProgress: makePushBridge(CH.EXTRACTION_PROGRESS),

  exportHTML: (params) =>
    ipcRenderer.invoke(CH.EXPORT_HTML, params),

  exportFile: (params) =>
    ipcRenderer.invoke(CH.EXPORT_FILE, params),

  importFile: () =>
    ipcRenderer.invoke(CH.IMPORT_FILE),

  registerBlob: (params) =>
    ipcRenderer.invoke(CH.REGISTER_BLOB, params),

  unregisterBlobsByComparison: (comparisonId) =>
    ipcRenderer.invoke(CH.UNREGISTER_BLOBS_BY_COMPARISON, comparisonId),

  openReport: (params) =>
    ipcRenderer.invoke(CH.OPEN_REPORT, params),

  getVersion: () =>
    ipcRenderer.invoke(CH.GET_VERSION),

  getPerfMetrics: () =>
    ipcRenderer.invoke(CH.GET_PERF_METRICS),
});