'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function makePushBridge(channel) {
  return (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {

  startComparison: (params) =>
    ipcRenderer.invoke('START_COMPARISON', params),

  onComparisonProgress: makePushBridge('COMPARISON_PROGRESS'),

  extractElements: (params) =>
    ipcRenderer.invoke('EXTRACT_ELEMENTS', params),

  onExtractionProgress: makePushBridge('EXTRACTION_PROGRESS'),

  loadReports: () =>
    ipcRenderer.invoke('LOAD_REPORTS'),

  deleteReport: (id) =>
    ipcRenderer.invoke('DELETE_REPORT', id),

  getCachedComparison: (baselineId, compareId, mode) =>
    ipcRenderer.invoke('GET_CACHED_COMPARISON', { baselineId, compareId, mode }),

  exportHTML: (params) =>
    ipcRenderer.invoke('EXPORT_HTML', params),

  exportFile: (params) =>
    ipcRenderer.invoke('EXPORT_FILE', params),

  importFile: () =>
    ipcRenderer.invoke('IMPORT_FILE'),

  registerBlob: (params) =>
    ipcRenderer.invoke('REGISTER_BLOB', params),

  unregisterBlobsByComparison: (comparisonId) =>
    ipcRenderer.invoke('UNREGISTER_BLOBS_BY_COMPARISON', comparisonId),

  getVersion: () =>
    ipcRenderer.invoke('GET_VERSION'),
});