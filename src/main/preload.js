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

  platform: process.platform,

  startComparison: (params) =>
    ipcRenderer.invoke(CH.START_COMPARISON, params),

  onComparisonProgress: makePushBridge(CH.COMPARISON_PROGRESS),

  extractElements: (params) =>
    ipcRenderer.invoke(CH.EXTRACT_ELEMENTS, params),

  onExtractionProgress: makePushBridge(CH.EXTRACTION_PROGRESS),

  cancelOperation: (payload) =>
    ipcRenderer.invoke(CH.CANCEL_OPERATION, payload),

  onOperationCancelled: makePushBridge(CH.OPERATION_CANCELLED),

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

  getAvailableBrowsers: (opts) =>
    ipcRenderer.invoke(CH.GET_AVAILABLE_BROWSERS, opts ?? {}),

  setWindowTitle: (title) =>
    ipcRenderer.send(CH.SET_WINDOW_TITLE, title),

  showContextMenu: (payload) =>
    ipcRenderer.send(CH.SHOW_CONTEXT_MENU, payload),

  onContextAction: makePushBridge(CH.CONTEXT_ACTION),

  onMenuAction: makePushBridge(CH.MENU_ACTION),

  onAppNotification: makePushBridge(CH.APP_NOTIFICATION),
});