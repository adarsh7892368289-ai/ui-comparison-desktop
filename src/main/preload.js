'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function makeRemover(channel) {
  return (listener) => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('electronAPI', {

  startComparison: (params) =>
    ipcRenderer.invoke('START_COMPARISON', params),

  onComparisonProgress: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('COMPARISON_PROGRESS', listener);
    return listener;
  },
  removeComparisonProgress: makeRemover('COMPARISON_PROGRESS'),

  onComparisonComplete: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('COMPARISON_COMPLETE', listener);
    return listener;
  },
  removeComparisonComplete: makeRemover('COMPARISON_COMPLETE'),

  onComparisonError: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('COMPARISON_ERROR', listener);
    return listener;
  },
  removeComparisonError: makeRemover('COMPARISON_ERROR'),

  extractElements: (params) =>
    ipcRenderer.invoke('EXTRACT_ELEMENTS', params),

  onExtractionProgress: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('EXTRACTION_PROGRESS', listener);
    return listener;
  },
  removeExtractionProgress: makeRemover('EXTRACTION_PROGRESS'),

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